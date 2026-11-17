/**
 * C-v4.1 commit 7, part A (ISS-1433): the rows the acceptance map found missing.
 * Ten reads on one HEAD walk the history once (counted through the runner),
 * a commit naming both the display id and the hash id counts once, reads never
 * write the record, and lastChanged with git unavailable. Part B rides along:
 * ledgerState on ticket get for both filename forms.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const seam = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../../../src/core/git-facts/runner.js", async (orig) => {
  const m = await orig<typeof import("../../../src/core/git-facts/runner.js")>();
  return { ...m, runGitFacts: (req: Parameters<typeof m.runGitFacts>[0]) => { seam.calls.push([...req.args]); return m.runGitFacts(req); } };
});

import { handleTicketGetWithGit } from "../../../src/cli/commands/ticket.js";
import type { CommandContext } from "../../../src/cli/types.js";
import { graphCache } from "../../../src/core/git-facts/cache.js";
import { clearAttributionCache } from "../../../src/core/git-facts/attribution.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo, tempDir } from "../../mcp/board-git-fixtures.js";

// Real git per row; reads run several git calls each.
vi.setConfig({ testTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
beforeEach(() => { seam.calls.length = 0; graphCache.clear(); clearAttributionCache(); });
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
const HASH = "t-0123456789abcdef";
const ticket = (id: string, extra: Json = {}): Json => ({
  id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0", order: 10,
  createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null, ...extra,
});

async function board(): Promise<{ root: string; codeSha: string }> {
  const { root } = await makeProjectRepo();
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify(ticket("T-001"), null, 2) + "\n");
  writeFileSync(join(root, ".story", "tickets", `${HASH}.json`), JSON.stringify(ticket(HASH, { displayId: "T-009" }), null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  writeFileSync(join(root, "code.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `T-001 T-009 ${HASH} the code`);
  const codeSha = headSha(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { root, codeSha };
}

async function ctx(root: string, format: "json" | "md"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format } as CommandContext;
}

async function get(root: string, id: string): Promise<Json> {
  const r = await handleTicketGetWithGit(id, await ctx(root, "json"));
  return (JSON.parse(r.output) as { data: Json }).data;
}

const isWalk = (args: string[]): boolean => args[0] === "log" && args.includes("-z") && args.includes("--format=%H%x00%P%x00%s");

describe("ISS-1433 rows", () => {
  it("ten reads on one HEAD walk the history once", async () => {
    const { root } = await board();
    for (let i = 0; i < 10; i += 1) await get(root, "T-001");
    expect(seam.calls.filter(isWalk)).toHaveLength(1);
    // A new HEAD is a new key: one more walk.
    writeFileSync(join(root, "more.txt"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "more");
    await get(root, "T-001");
    expect(seam.calls.filter(isWalk)).toHaveLength(2);
  }, 60_000);

  it("a commit naming both the display id and the hash id counts once", async () => {
    const { root, codeSha } = await board();
    const byDisplay = await get(root, "T-009");
    const byHash = await get(root, HASH);
    expect(byDisplay.gitState).toEqual(byHash.gitState);
    const gs = byHash.gitState as { state: string; counts: Record<string, number>; shas?: Record<string, string[]> };
    expect(gs.state).toBe("landed");
    const total = Object.values(gs.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
    expect(JSON.stringify(gs)).toContain(codeSha);
  });

  it("reads never write the record: bytes and mtime unchanged", async () => {
    const { root } = await board();
    const files = [join(root, ".story", "tickets", "T-001.json"), join(root, ".story", "tickets", `${HASH}.json`)];
    const before = files.map((f) => ({ bytes: readFileSync(f), mtime: statSync(f).mtimeMs }));
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ["T-001", "T-009", HASH]) { await get(root, id); await handleTicketGetWithGit(id, await ctx(root, "md")); }
    files.forEach((f, i) => {
      expect(readFileSync(f).equals(before[i]!.bytes)).toBe(true);
      expect(statSync(f).mtimeMs).toBe(before[i]!.mtime);
    });
    expect(git(root, "status", "--porcelain", "--", ".story/tickets").trim()).toBe("");
  }, 60_000);

  it("lastChanged and ledgerState are null when git is unavailable", async () => {
    const dir = tempDir("nogit");
    const { root } = await makeProjectRepo({ commit: false });
    // A board outside any repository: copy the .story directory into a plain temp dir.
    mkdirSync(join(dir, ".story", "tickets"), { recursive: true });
    for (const f of ["config.json", "roadmap.json"]) writeFileSync(join(dir, ".story", f), readFileSync(join(root, ".story", f)));
    writeFileSync(join(dir, ".story", "tickets", "T-001.json"), JSON.stringify(ticket("T-001"), null, 2) + "\n");
    const data = await get(dir, "T-001");
    expect(data.lastChanged).toBeNull();
    expect(data.ledgerState).toBeNull();
    expect((data.gitState as { state: string }).state).toBe("unknown");
    const md = (await handleTicketGetWithGit("T-001", await ctx(dir, "md"))).output;
    expect(md).toContain("record last changed unknown");
    expect(md).toContain("Ledger: unknown (git unavailable)");
  });
});

describe("part B: ledgerState on ticket get, both filename forms", () => {
  it("display-id filename and hash filename each resolve their own record path", async () => {
    const { root } = await board();
    const ledgerSha = git(root, "log", "-1", "--format=%H", "--", ".story/tickets/T-001.json").trim();
    expect((await get(root, "T-001")).ledgerState).toMatchObject({ state: "committed", sha: ledgerSha, remote: { relation: "contains" } });
    expect((await get(root, "T-009")).ledgerState).toMatchObject({ state: "committed", sha: ledgerSha });
    writeFileSync(join(root, ".story", "tickets", `${HASH}.json`), JSON.stringify(ticket(HASH, { displayId: "T-009", title: "edited" }), null, 2) + "\n");
    expect((await get(root, HASH)).ledgerState).toMatchObject({ state: "modified", sha: ledgerSha });
    expect((await get(root, "T-001")).ledgerState).toMatchObject({ state: "committed" });
    const md = (await handleTicketGetWithGit("T-009", await ctx(root, "md"))).output;
    expect(md).toContain(`Ledger: modified since ${ledgerSha}, on origin/main`);
  });
});
