/**
 * C-v4.1 commit 6: the section 7 surfaces on a real board. receipts check,
 * candidate on the MCP gets, land's advisory line (pen ruling Q3), and
 * unknown git facts never reading ready.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleReceiptsCheck } from "../../../src/cli/commands/receipt.js";
import { landReadiness, landingReady } from "../../../src/core/landing-ready.js";
import { captureTools, cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo } from "../../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
let seq = 0;
function rc(kind: "test" | "review", sha: string, base: string): Json {
  seq += 1;
  const r: Json = {
    id: `rc-${String(seq).padStart(16, "0")}`, v: 1, kind, target: "T-001", repo: "b-0000000000000000", sha,
    revisions: {}, observation: { head: sha, headMatchesSha: true, worktree: { staged: 0, unstaged: 0, untracked: 0, submodule: 0 } },
    result: "pass", recordedAt: "2026-11-16T00:00:00Z", recordedBy: "test",
  };
  if (kind === "test") r.attestation = { builtFromSha: sha, builtClean: true };
  else { r.base = base; r.data = { verdict: "approve" }; }
  return r;
}

const ticketPath = (root: string, id: string): string => join(root, ".story", "tickets", `${id}.json`);
function writeTicket(root: string, id: string, extra: Json = {}): void {
  writeFileSync(ticketPath(root, id), JSON.stringify({ id, title: id, description: "", type: "task", status: "inprogress", phase: "p0", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null, ...extra }, null, 2) + "\n");
}

/** Seven tickets; prior is the ledger commit, head carries one code commit per ticket. T-001 holds a passing test and review for prior..head. */
async function board(config: Json = {}): Promise<{ root: string; prior: string; head: string }> {
  const { root } = await makeProjectRepo();
  const cfgPath = join(root, ".story", "config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...(JSON.parse(readFileSync(cfgPath, "utf8")) as Json), ...config }, null, 2) + "\n");
  const ids = ["T-001", "T-002", "T-003", "T-004", "T-005", "T-006", "T-007"];
  for (const id of ids) writeTicket(root, id);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  const prior = headSha(root);
  for (const id of ids) {
    writeFileSync(join(root, `${id}.txt`), `${id}\n`);
    git(root, "add", `${id}.txt`);
    git(root, "commit", "-q", "-m", `${id} the code`);
  }
  const head = headSha(root);
  git(root, "update-ref", "refs/remotes/origin/main", head);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeTicket(root, "T-001", { receipts: [rc("test", head, prior), rc("review", head, prior)] });
  return { root, prior, head };
}

describe("land's advisory readiness line (pen ruling Q3)", () => {
  it("one line: the count, the ready count, at most five not-ready items by name, then and N more; JSON carries every item", async () => {
    const { root, prior, head } = await board();
    const r = await landReadiness(root, prior, head);
    expect(r.items).toHaveLength(7);
    expect(r.items.filter((i) => i.ready).map((i) => i.item)).toEqual(["T-001"]);
    expect(r.line).toBe(
      "Readiness (advisory pending ISS-1081): 7 items, 1 ready; " +
      ["T-002", "T-003", "T-004", "T-005", "T-006"].map((id) => `${id} not ready (missing test, review)`).join("; ") +
      "; and 1 more",
    );
  });

  it("says so when no item is attributed in the range, and when there is no prior tip or board", async () => {
    const { root, head } = await board();
    expect((await landReadiness(root, head, head)).line).toBe(`Readiness (advisory pending ISS-1081): no items attributed in ${head.slice(0, 8)}..${head.slice(0, 8)}`);
    expect((await landReadiness(root, null, head)).line).toContain("not computed (the prior tip is unknown)");
    expect((await landReadiness(null, null, head)).line).toContain("not computed (no board)");
  });

  it("reads the landing board's policy", async () => {
    const { root, prior, head } = await board({ receipts: { landingPolicy: { review: "optional", test: "optional" } } });
    const r = await landReadiness(root, prior, head);
    expect(r.line).toBe("Readiness (advisory pending ISS-1081): 7 items, 7 ready");
  });
});

describe("storybloq receipts check", () => {
  it("ready on the reviewed range, not ready (exit 1) without receipts, refuses a malformed candidate", async () => {
    const { root, prior, head } = await board();
    const ok = await handleReceiptsCheck(root, "T-001", { range: `${prior}..${head}` }, "md");
    expect(ok.output).toBe(`T-001 at ${prior.slice(0, 8)}..${head.slice(0, 8)}: ready`);
    expect(ok.exitCode).toBeUndefined();
    const no = await handleReceiptsCheck(root, "T-002", { sha: head }, "json");
    expect(no.exitCode).toBe(1);
    expect((JSON.parse(no.output) as { data: { landingReady: Json } }).data.landingReady).toMatchObject({ item: "T-002", ready: false, missing: ["test", "review"] });
    expect((await handleReceiptsCheck(root, "T-001", { sha: head.slice(0, 12) }, "md")).output).toContain("--sha takes a full");
    expect((await handleReceiptsCheck(root, "T-001", { sha: head, range: `${prior}..${head}` }, "md")).output).toContain("exactly one of");
    expect((await handleReceiptsCheck(root, "T-001", { range: head }, "md")).output).toContain("--range takes");
  });

  it("unknown git facts are never ready", async () => {
    const { root, prior, head } = await board({ gitState: { maxGraphCommits: 0 } });
    const r = await landingReady(root, "T-001", { base: prior, head });
    expect(r).toMatchObject({ ready: false });
    expect("unknown" in r && r.unknown).toMatch(/^git facts unknown: /);
  });
});

describe("candidate on storybloq_ticket_get", () => {
  it("adds landingReady only when candidate is passed, and refuses a malformed one", async () => {
    const { root, prior, head } = await board();
    const tools = captureTools(root);
    const plain = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json" })).text) as { data: Json };
    expect(plain.data).not.toHaveProperty("landingReady");
    const withCand = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json", candidate: `${prior}..${head}` })).text) as { data: Json };
    expect(withCand.data.landingReady).toMatchObject({ item: "T-001", ready: true });
    const md = await tools.call("storybloq_ticket_get", { id: "T-002", candidate: head });
    expect(md.text).toContain(`Landing: T-002 at ${head.slice(0, 8)}: not ready (missing test, review)`);
    const bad = await tools.call("storybloq_ticket_get", { id: "T-001", candidate: "HEAD" });
    expect(bad.text).toContain("candidate takes a full sha");
  });

  it("storybloq_issue_get takes candidate the same way", async () => {
    const { root, head } = await board();
    const tools = captureTools(root);
    const created = await tools.call("storybloq_issue_create", { title: "An issue", severity: "low", impact: "none" });
    const id = /ISS-\d+/.exec(created.text)![0];
    const plain = JSON.parse((await tools.call("storybloq_issue_get", { id, format: "json" })).text) as { data: Json };
    expect(plain.data).not.toHaveProperty("landingReady");
    const withCand = JSON.parse((await tools.call("storybloq_issue_get", { id, format: "json", candidate: head })).text) as { data: Json };
    expect(withCand.data.landingReady).toMatchObject({ ready: false, missing: ["test", "review"], candidate: { head, base: null } });
  });
});
