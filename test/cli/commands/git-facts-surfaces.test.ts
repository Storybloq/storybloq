/**
 * C-v4.1 commit 4, plan sections 4.4 and 8 with the pen's Q4 and Q5 rulings:
 * get carries gitState and lastChanged on both clients, status and ticket
 * list carry gitCounts, recommend lists landed-but-open first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleTicketGetWithGit, handleTicketListWithGit } from "../../../src/cli/commands/ticket.js";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { handleRecommend } from "../../../src/cli/commands/recommend.js";
import { handleTicketList } from "../../../src/cli/commands/ticket.js";
import { configureRawMode, rawRejectionPending, resetRawMode, transformForRawMode } from "../../../src/cli/raw-mode.js";
import type { CommandContext } from "../../../src/cli/types.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { captureTools, cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo } from "../../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
const ticket = (id: string, status: string): Json => ({
  id, title: `Ticket ${id}`, description: "", type: "task", status, phase: "p0", order: 10,
  createdDate: "2026-01-01", completedDate: status === "complete" ? "2026-01-02" : null, blockedBy: [], parentTicket: null,
});

/** T-001 open with landed code, T-004 complete with the same landed code, T-002 complete with code only on a branch, T-003 open with no commits. */
async function board(): Promise<{ root: string; landedSha: string }> {
  const { root } = await makeProjectRepo();
  for (const [id, status] of [["T-001", "open"], ["T-002", "complete"], ["T-003", "open"], ["T-004", "complete"]] as const) {
    writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify(ticket(id, status), null, 2) + "\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  writeFileSync(join(root, "code.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "T-001 T-004 the code");
  const landedSha = headSha(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "-b", "side");
  writeFileSync(join(root, "side.txt"), "two\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "T-002 branch only");
  git(root, "checkout", "-q", "main");
  return { root, landedSha };
}

async function ctx(root: string, format: "json" | "md"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format } as CommandContext;
}

describe("get carries gitState and lastChanged on both clients (Q4)", () => {
  it("CLI entry: landed state with its sha, and the record's last commit", async () => {
    const { root, landedSha } = await board();
    const r = await handleTicketGetWithGit("T-001", await ctx(root, "json"));
    const data = (JSON.parse(r.output) as { data: Json }).data;
    expect(data.gitState).toMatchObject({ state: "landed", shas: { landed: [landedSha] } });
    expect(data.lastChanged).toMatchObject({ sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it("MCP: the same fields, and built for a branch-only commit", async () => {
    const { root } = await board();
    const r = await captureTools(root).call("storybloq_ticket_get", { id: "T-002", format: "json" });
    const data = (JSON.parse(r.text) as { data: Json }).data;
    expect(data.gitState).toMatchObject({ state: "built" });
    expect(data).toHaveProperty("lastChanged");
  });

  it("an item with no attributed commit is none, and an edited record reads uncommitted", async () => {
    const { root } = await board();
    writeFileSync(join(root, ".story", "tickets", "T-003.json"), JSON.stringify({ ...ticket("T-003", "open"), title: "edited" }, null, 2) + "\n");
    const data = (JSON.parse((await handleTicketGetWithGit("T-003", await ctx(root, "json"))).output) as { data: Json }).data;
    expect(data.gitState).toMatchObject({ state: "none", counts: { released: 0, landed: 0, built: 0, none: 0 } });
    expect(data.lastChanged).toMatchObject({ uncommitted: true });
  });

  it("an untracked record reads uncommitted even when the repo hides untracked files (Codex finding 3)", async () => {
    const { root } = await board();
    git(root, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(root, ".story", "tickets", "T-009.json"), JSON.stringify(ticket("T-009", "open"), null, 2) + "\n");
    const data = (JSON.parse((await handleTicketGetWithGit("T-009", await ctx(root, "json"))).output) as { data: Json }).data;
    expect(data.lastChanged).toMatchObject({ uncommitted: true });
  });

  it("unknown facts are reported, never dropped", async () => {
    const { root } = await board();
    git(root, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    git(root, "config", "init.defaultBranch", "trunk");
    const data = (JSON.parse((await handleTicketGetWithGit("T-001", await ctx(root, "json"))).output) as { data: Json }).data;
    expect(data.gitState).toEqual({ state: "unknown", reason: "missing default", detail: "trunk" });
  });

  it("Markdown gets one git state line", async () => {
    const { root } = await board();
    const r = await handleTicketGetWithGit("T-001", await ctx(root, "md"));
    expect(r.output.split("\n").filter((l) => l.startsWith("Git state: "))).toHaveLength(1);
  });
});

describe("gitCounts on status and ticket list (Q5)", () => {
  it("status JSON carries gitCounts", async () => {
    const { root } = await board();
    const r = await handleStatus(await ctx(root, "json"));
    expect((JSON.parse(r.output) as { data: Json }).data.gitCounts).toEqual({ landedOpen: 1, completeUnlanded: 1, unknown: 0 });
  });

  it("compact status is unchanged", async () => {
    const { root } = await board();
    const r = await handleStatus(await ctx(root, "json"), undefined, { compact: true });
    expect((JSON.parse(r.output) as { data: Json }).data).not.toHaveProperty("gitCounts");
  });

  it("ticket list --raw is the data payload alone, byte-identical to the list without git counts", async () => {
    const { root } = await board();
    const c = await ctx(root, "json");
    const withGit = (await handleTicketListWithGit({}, c)).output;
    const plain = handleTicketList({}, c).output;
    configureRawMode(true, "json");
    try {
      expect(transformForRawMode(withGit)).toBe(transformForRawMode(plain));
      expect(rawRejectionPending()).toBe(false);
    } finally {
      resetRawMode();
    }
  });

  it("ticket list JSON puts gitCounts beside data and leaves the rows alone", async () => {
    const { root } = await board();
    const env = JSON.parse((await handleTicketListWithGit({}, await ctx(root, "json"))).output) as { data: Json[]; gitCounts: Json };
    expect(env.gitCounts).toEqual({ landedOpen: 1, completeUnlanded: 1, unknown: 0 });
    for (const row of env.data) expect(row).not.toHaveProperty("gitState");
  });
});

describe("recommend lists landed-but-open first (Q5)", () => {
  it("puts T-001 first, labelled", async () => {
    const { root } = await board();
    const r = await handleRecommend(await ctx(root, "json"), 5);
    const recs = (JSON.parse(r.output) as { data: { recommendations: Json[] } }).data.recommendations;
    expect(recs[0]).toMatchObject({ id: "T-001", category: "landed_open" });
  });

  it("keeps today's order when the facts are unknown", async () => {
    const { root } = await board();
    git(root, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    git(root, "config", "init.defaultBranch", "trunk");
    const r = await handleRecommend(await ctx(root, "json"), 5);
    const recs = (JSON.parse(r.output) as { data: { recommendations: Json[] } }).data.recommendations;
    expect(recs.some((x) => x.category === "landed_open")).toBe(false);
  });
});
