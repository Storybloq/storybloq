/**
 * C-v4.1 commit 4, plan 4.1 and 4.3: the runner's limits, the graph cache's
 * eviction (the ancestry memo counted against the cap), and attribution
 * (keyed by the pattern, id resolution never cached).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGitFacts, gitFactsEnv } from "../../src/core/git-facts/runner.js";
import { GraphCache, type GraphEntry } from "../../src/core/git-facts/cache.js";
import { GraphIndex } from "../../src/core/git-facts/graph-index.js";
import { takeGitSnapshot } from "../../src/core/git-facts/snapshot.js";
import { clearAttributionCache, itemFacts, tokenCommits } from "../../src/core/git-facts/attribution.js";
import { GitStateConfigSchema } from "../../src/models/config.js";
import { makePhase, makeRoadmap, makeState, makeTicket } from "./test-factories.js";
import { applyHandoverBoost, recommend } from "../../src/core/recommend.js";
import { PatternTimeoutError, sandboxTests, sandboxTokens } from "../../src/core/git-facts/pattern-sandbox.js";
import { makeIssue } from "./test-factories.js";
import { git as fixtureGit } from "../helpers/git-fixture.js";

describe("git facts runner (4.1)", () => {
  it("sets the sanitised env with both GIT_NO_* variables", () => {
    const env = gitFactsEnv({ PATH: "/bin", SECRET_TOKEN: "x" });
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it("passes -c core.fsmonitor=false ahead of the subcommand", async () => {
    const r = await runGitFacts({ cwd: tmpdir(), args: ["config", "--get", "core.fsmonitor"] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.stdout.toString("utf8").trim()).toBe("false");
  });

  it("at the time limit, sends SIGTERM, then SIGKILL two seconds later, and returns no output", async () => {
    // A child that ignores SIGTERM: only the SIGKILL ends it.
    const started = Date.now();
    const r = await runGitFacts({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('partial'); setInterval(()=>{},1000);"],
      timeoutMs: 300,
      env: process.env,
    });
    const took = Date.now() - started;
    expect(r).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(took).toBeGreaterThanOrEqual(2_000);
    expect(took).toBeLessThan(10_000);
  }, 30_000);

  it("at the output limit, stops the child and returns no partial output", async () => {
    const r = await runGitFacts({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "const b=Buffer.alloc(65536,97); const w=()=>{while(process.stdout.write(b)){} process.stdout.once('drain',w)}; w();"],
      maxBytes: 100_000,
      env: process.env,
    });
    expect(r).toMatchObject({ kind: "failed", reason: "output" });
    expect("stdout" in r).toBe(false);
  }, 30_000);

  it("past the record bound, stops with records", async () => {
    const r = await runGitFacts({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('a\\0b\\0c\\0d\\0')"],
      maxNuls: 3,
      env: process.env,
    });
    expect(r).toMatchObject({ kind: "failed", reason: "records" });
  }, 30_000);
});

function chainIndex(n: number): GraphIndex {
  const parents = new Map<string, string[]>();
  for (let i = 0; i < n; i += 1) parents.set(`c${i}`, i === 0 ? [] : [`c${i - 1}`]);
  return new GraphIndex(parents, new Map(), new Set(), { fromDefault: [`c${n - 1}`], fromRelease: [], fromBranch: [] });
}

describe("graph cache (4.3)", () => {
  it("keeps at most four entries, oldest out", () => {
    const cache = new GraphCache(4, 1 << 30);
    for (let i = 0; i < 5; i += 1) cache.set({ key: `k${i}`, graph: chainIndex(3) });
    expect(cache.size).toBe(4);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k4")).toBe(true);
  });

  it("counts the ancestry memo against the cap and drops a memo before evicting an entry", () => {
    const g = chainIndex(2000);
    const table = g.byteEstimate();
    // Room for both tables plus a little: one ancestor bitset (2000 bytes) fits, many do not.
    const cache = new GraphCache(4, 2 * table + 5_000);
    const a: GraphEntry = { key: "a", graph: g };
    const b: GraphEntry = { key: "b", graph: chainIndex(2000) };
    cache.set(a);
    cache.set(b);
    for (let i = 1; i < 50; i += 1) expect(cache.isAncestor(b, "c0", `c${i * 40 - 1}`)).toBe(true);
    expect(cache.totalBytes()).toBeLessThanOrEqual(2 * table + 5_000);
    expect(b.memoBytes ?? 0).toBeGreaterThan(0);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
  });

  it("on a new entry that would pass the cap, drops the memos before evicting any entry", () => {
    const table = chainIndex(2000).byteEstimate();
    const cache = new GraphCache(4, 2 * table + 3_000);
    const a: GraphEntry = { key: "a", graph: chainIndex(2000) };
    cache.set(a);
    cache.isAncestor(a, "c0", "c1999");
    cache.isAncestor(a, "c0", "c1500");
    expect(a.memoBytes ?? 0).toBeGreaterThan(table > 0 ? 3_000 : 0);
    cache.set({ key: "b", graph: chainIndex(2000) });
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
    expect(a.memo).toBeUndefined();
    expect(cache.totalBytes()).toBeLessThanOrEqual(2 * table + 3_000);
  });

  it("never retains an entry larger than the cap (Codex finding 2)", () => {
    const big = chainIndex(2000);
    const cache = new GraphCache(4, Math.floor(big.byteEstimate() / 2));
    cache.set({ key: "big", graph: big });
    expect(cache.has("big")).toBe(false);
    expect(cache.totalBytes()).toBeLessThanOrEqual(Math.floor(big.byteEstimate() / 2));
  });

  it("answers false at once when the position order rules it out", () => {
    const cache = new GraphCache();
    const e: GraphEntry = { key: "x", graph: chainIndex(5) };
    cache.set(e);
    expect(cache.isAncestor(e, "c4", "c1")).toBe(false);
    expect(e.memo).toBeUndefined();
  });
});

describe("gitState config (4.2, Q2 ruling)", () => {
  it.each([
    ["maxGraphCommits", -1],
    ["maxGraphCommits", 1.5],
    ["maxGraphCommits", "10"],
    ["maxRefs", 0],
    ["subjectPattern", "("],
    ["subjectPattern", "a".repeat(201)],
    ["releaseTagPattern", "[unclosed"],
    ["defaultBranch", "bad name"],
  ])("refuses %s = %j by name", (field, value) => {
    const r = GitStateConfigSchema.safeParse({ [field]: value });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual([field]);
  });

  it("accepts 0 for maxGraphCommits and an absent block", () => {
    expect(GitStateConfigSchema.safeParse({ maxGraphCommits: 0 }).success).toBe(true);
    expect(GitStateConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("attribution (4.3)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gitfacts-attr-"));
    fixtureGit(root, ["init", "-q", "-b", "main", "--object-format=sha1"]);
    fixtureGit(root, ["config", "user.email", "t@example.com"]);
    fixtureGit(root, ["config", "user.name", "T"]);
    clearAttributionCache();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function commit(subject: string, file: string): string {
    writeFileSync(join(root, file), subject);
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", subject]);
    return fixtureGit(root, ["rev-parse", "HEAD"]);
  }

  it("keys the token cache by the subject pattern", async () => {
    commit("T-001 default form", "a.txt");
    commit("[job-7] custom form", "b.txt");
    const s = await takeGitSnapshot(root, { defaultBranch: "main", noCache: true });
    if (s.status !== "ok") throw new Error(s.reason);
    expect([...tokenCommits(s).keys()]).toEqual(["T-001"]);
    expect([...tokenCommits(s, /\[(job-\d+)\]/).keys()]).toEqual(["job-7"]);
    expect([...tokenCommits(s).keys()]).toEqual(["T-001"]);
  });

  it("a backtracking subject pattern makes attribution time out, not hang (Codex finding 1)", async () => {
    commit("a".repeat(40) + "!", "evil.txt");
    const s = await takeGitSnapshot(root, { defaultBranch: "main", noCache: true });
    if (s.status !== "ok") throw new Error(s.reason);
    const started = Date.now();
    expect(() => tokenCommits(s, /(a+)+$/)).toThrow(PatternTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("a backtracking release pattern makes the snapshot unknown, not hang (Codex finding 1)", async () => {
    commit("T-001 base", "base.txt");
    fixtureGit(root, ["tag", "a".repeat(40) + "-x"]);
    const started = Date.now();
    const s = await takeGitSnapshot(root, { defaultBranch: "main", releaseTagPattern: "(a+)+$", noCache: true });
    expect(s).toMatchObject({ status: "unknown", reason: "pattern timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("resolves ids on every read, so a renamed display id takes effect without a rescan", async () => {
    const sha = commit("T-002 work", "c.txt");
    const s = await takeGitSnapshot(root, { defaultBranch: "main", noCache: true });
    if (s.status !== "ok") throw new Error(s.reason);
    const before = makeState({ tickets: [makeTicket({ id: "t-0000000000000001", displayId: "T-002" } as never)] });
    expect(itemFacts(s, before).get("t-0000000000000001")?.state).toBe("landed");
    // A reconcile moves T-002 to another record; the cached tokens are reused, the answer follows the ledger.
    const after = makeState({ tickets: [makeTicket({ id: "t-0000000000000002", displayId: "T-002" } as never), makeTicket({ id: "t-0000000000000001", displayId: "T-090" } as never)] });
    const facts = itemFacts(s, after);
    expect(facts.get("t-0000000000000002")?.shas.landed).toEqual([sha]);
    expect(facts.has("t-0000000000000001")).toBe(false);
  });
});

describe("recommend: landed-but-open first (Q5)", () => {
  it("lists a landed open ticket first even when a far-phase penalty would sink its score", () => {
    const phases = ["p0", "p1", "p2", "p3", "p4"].map((id) => makePhase({ id }));
    const state = makeState({
      roadmap: makeRoadmap(phases),
      tickets: [
        makeTicket({ id: "T-001", phase: "p4", status: "open" }),
        makeTicket({ id: "T-005", phase: "p0", status: "inprogress" }),
      ],
    });
    const recs = recommend(state, 5, { landedOpen: new Set(["T-001"]) }).recommendations;
    expect(recs[0]).toMatchObject({ id: "T-001", category: "landed_open" });
    expect(recs.map((r) => r.id)).toContain("T-005");
  });

  it("without landedOpen, today's order is kept, exactly, across competing categories", () => {
    const phases = ["p0", "p1", "p2"].map((id) => makePhase({ id }));
    const state = makeState({
      roadmap: makeRoadmap(phases),
      tickets: [
        makeTicket({ id: "T-001", phase: "p2", status: "open" }),
        makeTicket({ id: "T-002", phase: "p0", status: "inprogress" }),
        makeTicket({ id: "T-003", phase: "p0", status: "open", order: 20 }),
      ],
      issues: [makeIssue({ id: "ISS-001", severity: "critical" }), makeIssue({ id: "ISS-002", severity: "low" })],
    });
    const shape = (o?: Parameters<typeof recommend>[2]) => recommend(state, 10, o).recommendations.map((r) => [r.id, r.category]);
    // main's own output for this state (computed on origin/main's recommend, before this series).
    const expected = [["ISS-001", "critical_issue"], ["T-002", "inprogress_ticket"], ["ISS-002", "open_issue"]];
    expect(shape()).toEqual(expected);
    expect(shape({})).toEqual(expected);
    expect(shape({ landedOpen: undefined })).toEqual(expected);
  });

  it("a handover promotion never demotes landed-but-open (Codex finding 5)", () => {
    // Landed-open scores run 1100 down by one per item and the phase penalty is capped at 400, so only the
    // 27th landed-open item in a far phase falls under the handover score of 675; recommend shows at most
    // ten, so the guard is checked on applyHandoverBoost directly.
    const state = makeState({ tickets: [makeTicket({ id: "T-027", phase: "p4", status: "open" })] });
    const rec = {
      id: "T-027", kind: "ticket" as const, title: "x", category: "landed_open" as const, reason: "Landed but still open (future phase)", score: 674,
      actionability: { status: "actionable" as const },
    };
    const dedup = new Map([["T-027", rec as never]]);
    applyHandoverBoost(state, dedup, new Map([["T-027", 2]]), { latestDispositionById: new Map(), windowIncomplete: false });
    expect(dedup.get("T-027")).toMatchObject({ category: "landed_open", score: 674 });
  });
});

describe("configured patterns run with a deadline (Codex finding 1)", () => {
  const evil = /(a+)+$/;
  const input = "a".repeat(40) + "!";

  it("a backtracking subject pattern is interrupted at the deadline, not left to hang", () => {
    const started = Date.now();
    expect(() => sandboxTokens("gitState.subjectPattern", evil, [input], 200)).toThrow(PatternTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("a backtracking release pattern is interrupted too", () => {
    const started = Date.now();
    expect(() => sandboxTests("gitState.releaseTagPattern", evil, [input], 200)).toThrow(PatternTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("a sane pattern gives the same answers as a native run", () => {
    expect(sandboxTokens("p", /\[(job-\d+)\]/, ["[job-7] x [job-9]", "none"])).toEqual([["job-7", "job-9"], []]);
    expect(sandboxTests("p", /^v?\d+\.\d+\.\d+/, ["v1.2.3", "nightly"])).toEqual([true, false]);
  });
});
