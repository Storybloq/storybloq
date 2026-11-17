/**
 * C-v4.1 commit 7, part B: the ledger-state line on ruling get and on handover
 * latest and get (full mode only, one per handover), on both clients. Brief and
 * priming stay byte-identical, and N handovers cost a bounded number of git
 * calls (one status, one ref resolution, one log per file, one count per sha).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const seam = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../../../src/core/git-facts/runner.js", async (orig) => {
  const m = await orig<typeof import("../../../src/core/git-facts/runner.js")>();
  return { ...m, runGitFacts: (req: Parameters<typeof m.runGitFacts>[0]) => { seam.calls.push([...req.args]); return m.runGitFacts(req); } };
});

import { handleHandoverGet, handleHandoverLatest } from "../../../src/cli/commands/handover.js";
import type { CommandContext } from "../../../src/cli/types.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { captureTools, cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo } from "../../mcp/board-git-fixtures.js";

// Real git per row; reads run several git calls each.
vi.setConfig({ testTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
beforeEach(() => { seam.calls.length = 0; });
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
const setOrigin = (root: string): void => {
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
};
async function ctx(root: string, format: "json" | "md"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format } as CommandContext;
}
const handovers = (root: string): string[] => readdirSync(join(root, ".story", "handovers")).filter((f) => f.endsWith(".md")).sort().reverse();

/** Three handovers: the oldest two committed together (one sha), the newest untracked. */
async function board(): Promise<string> {
  const { root } = await makeProjectRepo();
  const tools = captureTools(root);
  for (const slug of ["one", "two"]) {
    const r = await tools.call("storybloq_handover_create", { content: `# Handover ${slug}\n\nState.\n`, slug });
    expect(r.isError, r.text).toBe(false);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "handovers");
  setOrigin(root);
  const r = await tools.call("storybloq_handover_create", { content: "# Handover three\n\nState.\n", slug: "three" });
  expect(r.isError, r.text).toBe(false);
  return root;
}

describe("ruling get", () => {
  it("carries ledgerState in JSON and the line in Markdown, on both clients", async () => {
    const { root } = await makeProjectRepo();
    setOrigin(root);
    const tools = captureTools(root);
    const created = await tools.call("storybloq_ruling_create", { text: "Ship on green.", attribution: "owner-direct", date: "2026-02-02", clientTaskId: "c7-task" });
    expect(created.isError, created.text).toBe(false);
    const id = /\br-[0-9a-z]+\b/.exec(created.text)![0];
    const md = await tools.call("storybloq_ruling_get", { id });
    expect(md.text).toContain("Ledger: untracked");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "ruling");
    const sha = headSha(root);
    setOrigin(root);
    expect((await tools.call("storybloq_ruling_get", { id })).text).toContain(`Ledger: committed at ${sha}, on origin/main`);
    const { handleRulingGetWithLedger } = await import("../../../src/cli/commands/ruling.js");
    const json = JSON.parse((await handleRulingGetWithLedger(id, await ctx(root, "json"))).output) as { data: Json };
    expect(json.data.ledgerState).toMatchObject({ state: "committed", sha, remote: { ref: "origin/main", relation: "contains" } });
    const missing = await handleRulingGetWithLedger("r-0000000000000000", await ctx(root, "md"));
    expect(missing.errorCode).toBe("not_found");
  });
});

describe("handover latest and get, full mode", () => {
  it("one line under each handover heading, and the field on each JSON handover", async () => {
    const root = await board();
    const [three, two, one] = handovers(root);
    const sha = git(root, "log", "-1", "--format=%H", "--", `.story/handovers/${one}`).trim();
    const md = (await handleHandoverLatest(await ctx(root, "md"), 3, { ledger: true })).output;
    expect(md).toContain("# Handover three\n\nLedger: untracked\n");
    expect(md).toContain(`# Handover two\n\nLedger: committed at ${sha}, on origin/main\n`);
    expect(md).toContain(`# Handover one\n\nLedger: committed at ${sha}, on origin/main\n`);
    expect(md.match(/^Ledger: /gm)).toHaveLength(3);

    const json = (await handleHandoverLatest(await ctx(root, "json"), 3, { ledger: true })).output.split(/\n(?=\{)/).map((p) => JSON.parse(p) as { data: Json });
    expect(json.map((j) => j.data.filename)).toEqual([three, two, one]);
    expect(json.map((j) => (j.data.ledgerState as { state: string }).state)).toEqual(["untracked", "committed", "committed"]);

    const get = (await handleHandoverGet(two!, await ctx(root, "md"), { ledger: true })).output;
    expect(get).toContain(`# Handover two\n\nLedger: committed at ${sha}, on origin/main\n`);
  });

  it("the MCP tools carry the line; brief and priming are byte-identical to the call without the ledger", async () => {
    const root = await board();
    const tools = captureTools(root);
    expect((await tools.call("storybloq_handover_latest", { count: 2 })).text.match(/^Ledger: /gm)).toHaveLength(2);
    expect((await tools.call("storybloq_handover_get", { filename: handovers(root)[0] })).text).toContain("Ledger: untracked");
    for (const opts of [{ brief: true }, { priming: true }, { brief: true, priming: true }]) {
      for (const format of ["md", "json"] as const) {
        const withLedger = (await handleHandoverLatest(await ctx(root, format), 3, { ...opts, ledger: true })).output;
        const without = (await handleHandoverLatest(await ctx(root, format), 3, opts)).output;
        expect(withLedger).toBe(without);
        expect(withLedger).not.toContain("Ledger:");
        expect(withLedger).not.toContain("ledgerState");
      }
    }
  });

  it("the guide's internal call (no ledger option) is unchanged", async () => {
    const root = await board();
    const plain = (await handleHandoverLatest(await ctx(root, "md"), 3)).output;
    expect(plain).not.toContain("Ledger:");
  });

  it("N handovers cost a bounded number of git calls", async () => {
    const root = await board();
    seam.calls.length = 0;
    await handleHandoverLatest(await ctx(root, "md"), 3, { ledger: true });
    const verbs = seam.calls.map((a) => a[0]);
    expect(verbs.filter((v) => v === "status")).toHaveLength(1);
    expect(verbs.filter((v) => v === "symbolic-ref")).toHaveLength(1);
    // Two committed files share one sha: two logs, one count; the untracked one needs neither.
    expect(verbs.filter((v) => v === "log")).toHaveLength(2);
    expect(verbs.filter((v) => v === "rev-list")).toHaveLength(1);
    // identity, status, ls-files, symbolic-ref, the ref rev-parse, two logs, one count.
    expect(verbs).toHaveLength(8);
  });
});
