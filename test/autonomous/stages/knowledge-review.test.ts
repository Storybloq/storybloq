/**
 * T-527: KNOWLEDGE_REVIEW at stage level, against REAL temporary git
 * repositories (the rules read git, so a mocked history would prove nothing).
 *
 * Standalone temp repositories only (ISS-1220). The public-guide paths
 * (resume, pre_compact, limit park, drift, the MCP boundary) are in
 * test/autonomous/knowledge-review-guide.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { StageContext, type ResolvedRecipe, type StageAdvance, type StageResult } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import {
  CHANGED_PATHS_DISCLOSURE,
  EVIDENCE_BUDGET_BYTES,
  EVIDENCE_FIELD_CHARS,
  KnowledgeReviewStage,
  evidenceCachePath,
  upsertKnowledgeImpact,
  type KnowledgeImpactRecord,
} from "../../../src/autonomous/stages/knowledge-review.js";
import { legacyAttemptId, pendingKnowledgeReview } from "../../../src/autonomous/stages/knowledge-routing.js";
import {
  KNOWLEDGE_INLINE_SHOWN,
  KNOWLEDGE_SECTION_BUDGET_BYTES,
  acceptedKnowledgeLine,
  knowledgeImpactSection,
} from "../../../src/autonomous/knowledge-impact-summary.js";
import { realKnowledgeGit } from "../../../src/autonomous/knowledge-verify.js";
import { CAPABILITIES_CAP } from "../../../src/autonomous/context-brief.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const SESSION_ID = "00000000-0000-0000-0000-0000000527aa";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const ISSUE_ID = "i-0000000000000001";
const TICKET_ID = "T-001";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" }).trim();
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
function doc(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

const DATE = "2026-09-22";
function capability(id: string, entryPoints: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id.replace(/^cap-/, ""),
    summary: `The ${id} module.`,
    entryPoints,
    contract: `Does the ${id} thing.`,
    checkedAt: { sha: "0".repeat(40), date: DATE },
    status: "current",
    ...overrides,
  };
}
const ISSUE_DOC = {
  id: ISSUE_ID,
  displayId: "ISS-001",
  title: "Old module is misnamed",
  status: "open",
  severity: "low",
  components: [],
  impact: "src/old.ts is named for a behaviour it no longer has.",
  resolution: null,
  location: ["src/old.ts"],
  discoveredDate: DATE,
  resolvedDate: null,
  relatedTickets: [],
};
const TICKET_DOC = {
  id: TICKET_ID,
  title: "Rename the old module",
  description: "Rename src/old.ts to src/new.ts and adjust src/a.ts.",
  type: "task",
  status: "inprogress",
  phase: null,
  order: 10,
  createdDate: DATE,
  completedDate: null,
  blockedBy: [],
  parentTicket: null,
};

/**
 * A ledger with two capabilities (cap-core on `src/a.ts`, cap-old on the file
 * the item renames), one issue and one ticket; then the item's
 * implementation commit.
 */
function setup(capOverrides: Record<string, Record<string, unknown>> = {}): { root: string; dir: string; base: string; impl: string } {
  const root = mkdtempSync(join(tmpdir(), "knowledge-review-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  write(root, ".gitignore", ".story/sessions/\n");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/old.ts", "export const old = 1;\n");
  write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [capability("cap-core", ["src/a.ts"], capOverrides["cap-core"]), capability("cap-old", ["src/old.ts"], capOverrides["cap-old"])] }));
  write(root, `.story/issues/${ISSUE_ID}.json`, doc(ISSUE_DOC));
  write(root, `.story/tickets/${TICKET_ID}.json`, doc(TICKET_DOC));
  // T-537: FINALIZE loads the project to check owner checkpoints, so the ledger must load.
  write(root, ".story/config.json", doc({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }));
  write(root, ".story/roadmap.json", doc({ title: "test", date: "2026-03-30", phases: [], blockers: [] }));
  const base = commit(root, "base");
  git(root, ["mv", "src/old.ts", "src/new.ts"]);
  write(root, "src/a.ts", "export const a = 2;\n");
  write(root, `.story/issues/${ISSUE_ID}.json`, doc({ ...ISSUE_DOC, status: "resolved", resolution: "renamed", resolvedDate: DATE }));
  write(root, `.story/tickets/${TICKET_ID}.json`, doc({ ...TICKET_DOC, status: "complete", completedDate: DATE }));
  const impl = commit(root, "implementation");
  const dir = join(root, ".story", "sessions", SESSION_ID);
  mkdirSync(dir, { recursive: true });
  return { root, dir, base, impl };
}

function makeState(root: string, base: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: "precommit_passed",
    git: {
      branch: "main",
      mergeBase: base,
      expectedHead: base,
      initHead: base,
      itemBaseHead: base,
      autoStash: null,
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: undefined,
    currentIssue: undefined,
    resolvedIssues: [],
    resolvedIssueDisplayIds: {},
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    frozenGate: { status: "ungated" },
    itemAttempt: null,
    knowledgeReview: null,
    knowledgeImpacts: [],
    ...overrides,
  } as unknown as FullSessionState;
}

function recipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "IMPLEMENT", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
  } as unknown as ResolvedRecipe;
}

function ctxFor(root: string, dir: string, state: FullSessionState): StageContext {
  return new StageContext(root, dir, { ...state }, recipe());
}

const attempt = (workItemId: string, kind: "ticket" | "issue") => ({ id: `att-${workItemId}`, workItemId, kind, startedAt: "2026-09-22T00:00:00.000Z", generation: 1 });

/** Every update passed to writeState, in order; the real write is still made. */
function recordWrites(ctx: StageContext): Partial<FullSessionState>[] {
  const writes: Partial<FullSessionState>[] = [];
  const real = ctx.writeState.bind(ctx);
  ctx.writeState = ((updates, opts) => {
    writes.push(updates);
    return real(updates, opts);
  }) as StageContext["writeState"];
  return writes;
}

/** The commit's write carries the pending review; no other write touches it (no crash window). */
function expectReviewInCommitWrite(writes: Partial<FullSessionState>[], item: { kind: "ticket" | "issue"; id: string }): void {
  const touching = writes.filter((w) => "knowledgeReview" in w);
  expect(touching).toHaveLength(1);
  expect(touching[0]).toMatchObject({
    finalizeCheckpoint: "committed",
    finalizedItem: { kind: item.kind, id: item.id },
    knowledgeReview: { itemId: item.id, kind: item.kind, status: "pending" },
  });
}

function instructionOf(r: StageResult | StageAdvance): string {
  if ("instruction" in r && typeof r.instruction === "string") return r.instruction;
  if ("result" in r && r.result) return r.result.instruction;
  return "";
}

function pendingAt(state: FullSessionState, item: { kind: "ticket" | "issue"; id: string }, impl: string): FullSessionState {
  return { ...state, state: "KNOWLEDGE_REVIEW", finalizeCheckpoint: "committed", knowledgeReview: pendingKnowledgeReview(state, item, impl) } as FullSessionState;
}

function noneReport(impl: string, maintenanceCommits: string[] = []): Record<string, unknown> {
  return { implementationCommit: impl, maintenanceCommits, checked: ["cap-core"], outcome: "none", reason: "nothing recorded changed" };
}

// ---------------------------------------------------------------------------

describe("storage key: (itemAttemptId, implementationCommit)", () => {
  const record = (itemAttemptId: string, implementationCommit: string, acceptedAt: string): KnowledgeImpactRecord => ({
    itemId: "T-1",
    kind: "ticket",
    itemAttemptId,
    implementationCommit,
    headAtAcceptance: implementationCommit,
    maintenanceCommits: [],
    externalMaintenance: [],
    checkpoints: [],
    acceptedAt,
    report: { implementationCommit, maintenanceCommits: [], checked: ["cap-a"], outcome: "none", reason: "r" },
  });

  it("the same key accepted twice replaces the earlier record in place", () => {
    const a = record("att-1", "a".repeat(40), "first");
    const other = record("att-0", "b".repeat(40), "other");
    const out = upsertKnowledgeImpact([other, a], record("att-1", "a".repeat(40), "second"));
    expect(out.map((r) => r.acceptedAt)).toEqual(["other", "second"]);
  });

  it("another attempt with the same commit is a new record", () => {
    const out = upsertKnowledgeImpact([record("att-1", "a".repeat(40), "x")], record("att-2", "a".repeat(40), "y"));
    expect(out).toHaveLength(2);
  });

  it("the same attempt with another commit is a new record", () => {
    const out = upsertKnowledgeImpact([record("att-1", "a".repeat(40), "x")], record("att-1", "b".repeat(40), "y"));
    expect(out).toHaveLength(2);
  });
});

describe("the pending record FINALIZE writes (D1)", () => {
  it("uses the item's attempt when it matches the item", () => {
    const { root, base, impl } = setup();
    const state = makeState(root, base, { itemAttempt: attempt(TICKET_ID, "ticket") } as Partial<FullSessionState>);
    expect(pendingKnowledgeReview(state, { kind: "ticket", id: TICKET_ID }, impl)).toEqual({
      itemId: TICKET_ID,
      kind: "ticket",
      itemAttemptId: `att-${TICKET_ID}`,
      implementationCommit: impl,
      checkpoint: impl,
      status: "pending",
    });
  });

  it("falls back to legacy:<itemId>:<hash8> with no attempt, and with another item's attempt", () => {
    const { root, base, impl } = setup();
    const none = makeState(root, base);
    expect(pendingKnowledgeReview(none, { kind: "issue", id: ISSUE_ID }, impl).itemAttemptId).toBe(`legacy:${ISSUE_ID}:${impl.slice(0, 8)}`);
    const foreign = makeState(root, base, { itemAttempt: attempt("T-999", "ticket") } as Partial<FullSessionState>);
    expect(pendingKnowledgeReview(foreign, { kind: "ticket", id: TICKET_ID }, impl).itemAttemptId).toBe(legacyAttemptId(TICKET_ID, impl));
    const wrongKind = makeState(root, base, { itemAttempt: attempt(TICKET_ID, "issue") } as Partial<FullSessionState>);
    expect(pendingKnowledgeReview(wrongKind, { kind: "ticket", id: TICKET_ID }, impl).itemAttemptId).toBe(legacyAttemptId(TICKET_ID, impl));
  });
});

describe("routing: every FINALIZE exit reaches KNOWLEDGE_REVIEW", () => {
  const finalize = new FinalizeStage();

  it("the issue path records the review in the commit's write and goes to KNOWLEDGE_REVIEW", async () => {
    const { root, dir, base, impl } = setup();
    const ctx = ctxFor(root, dir, makeState(root, base, {
      currentIssue: { id: ISSUE_ID, displayId: "ISS-001", title: "fixture", severity: "low" },
      itemAttempt: attempt(ISSUE_ID, "issue"),
    } as Partial<FullSessionState>));
    const writes = recordWrites(ctx);
    const out = await finalize.report(ctx, { completedAction: "commit_done", commitHash: impl });
    expect(out).toEqual({ action: "goto", target: "KNOWLEDGE_REVIEW" });
    expectReviewInCommitWrite(writes, { kind: "issue", id: ISSUE_ID });
    const onDisk = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
    expect(onDisk.finalizeCheckpoint).toBe("committed");
    expect(onDisk.finalizedItem).toEqual({ kind: "issue", id: ISSUE_ID, commitHash: impl });
    expect(onDisk.knowledgeReview).toEqual({
      itemId: ISSUE_ID, kind: "issue", itemAttemptId: `att-${ISSUE_ID}`, implementationCommit: impl, checkpoint: impl, status: "pending",
    });
    expect(onDisk.currentIssue ?? null).toBeNull();
  });

  it("the ticket path records the review in the commit's write and goes to KNOWLEDGE_REVIEW", async () => {
    const { root, dir, base, impl } = setup();
    const ctx = ctxFor(root, dir, makeState(root, base, {
      ticket: { id: TICKET_ID, title: "Rename the old module", risk: "low" },
      itemAttempt: attempt(TICKET_ID, "ticket"),
    } as Partial<FullSessionState>));
    // No claim epoch in this fixture: attribution is overridden, as the ISS-063 tests do.
    const writes = recordWrites(ctx);
    const out = await finalize.report(ctx, { completedAction: "commit_done", commitHash: impl, overrideAttribution: true });
    expect(out).toEqual({ action: "goto", target: "KNOWLEDGE_REVIEW" });
    expectReviewInCommitWrite(writes, { kind: "ticket", id: TICKET_ID });
    const onDisk = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
    expect(onDisk.knowledgeReview?.status).toBe("pending");
    expect(onDisk.knowledgeReview?.itemId).toBe(TICKET_ID);
    expect(onDisk.completedTickets.map((t) => t.id)).toEqual([TICKET_ID]);
  });

  it("a null itemAttempt finalizes and records legacy:<itemId>:<hash8> (D1)", async () => {
    const { root, dir, base, impl } = setup();
    const ctx = ctxFor(root, dir, makeState(root, base, {
      ticket: { id: TICKET_ID, title: "Rename the old module", risk: "low" },
      itemAttempt: null,
    } as Partial<FullSessionState>));
    expect(await finalize.report(ctx, { completedAction: "commit_done", commitHash: impl, overrideAttribution: true })).toEqual({ action: "goto", target: "KNOWLEDGE_REVIEW" });
    expect(ctx.state.knowledgeReview?.itemAttemptId).toBe(`legacy:${TICKET_ID}:${impl.slice(0, 8)}`);
  });

  it("the no-item commit shape records no review and keeps its original exit", async () => {
    const { root, dir, base, impl } = setup();
    const ctx = ctxFor(root, dir, makeState(root, base));
    const out = await finalize.report(ctx, { completedAction: "commit_done", commitHash: impl });
    expect(out).toEqual({ action: "advance" });
    expect(ctx.state.knowledgeReview).toBeNull();
  });

  it("both committed re-entry guards route to the pending review, and keep their exit once it is accepted or absent", async () => {
    const { root, dir, base, impl } = setup();
    const committed = makeState(root, base, { finalizeCheckpoint: "committed" } as Partial<FullSessionState>);
    const pending = { ...committed, knowledgeReview: pendingKnowledgeReview(committed, { kind: "ticket", id: TICKET_ID }, impl) } as FullSessionState;
    expect(await finalize.enter(ctxFor(root, dir, pending))).toEqual({ action: "goto", target: "KNOWLEDGE_REVIEW" });
    expect(await finalize.report(ctxFor(root, dir, pending), { completedAction: "commit_done", commitHash: impl })).toEqual({ action: "goto", target: "KNOWLEDGE_REVIEW" });

    const accepted = { ...pending, knowledgeReview: { ...pending.knowledgeReview!, status: "accepted" } } as FullSessionState;
    expect(await finalize.enter(ctxFor(root, dir, accepted))).toEqual({ action: "advance" });
    expect(await finalize.report(ctxFor(root, dir, accepted), { completedAction: "commit_done", commitHash: impl })).toEqual({ action: "advance" });
    // A state written before T-527 has no record at all.
    const legacy = { ...committed } as Record<string, unknown>;
    delete legacy.knowledgeReview;
    expect(await finalize.enter(ctxFor(root, dir, legacy as FullSessionState))).toEqual({ action: "advance" });
  });
});

describe("COMPLETE never carries a pending review past its clearing write", () => {
  it("redirects before any write: the attempt, implementer and finalized item survive", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base, {
      state: "COMPLETE",
      itemAttempt: attempt(TICKET_ID, "ticket"),
      finalizedItem: { kind: "ticket", id: TICKET_ID, commitHash: impl },
    } as Partial<FullSessionState>), { kind: "ticket", id: TICKET_ID }, impl);
    const ctx = ctxFor(root, dir, { ...state, state: "COMPLETE" } as FullSessionState);
    expect(await new CompleteStage().enter(ctx)).toEqual({ action: "goto", target: "KNOWLEDGE_REVIEW" });
    expect(ctx.state.itemAttempt?.id).toBe(`att-${TICKET_ID}`);
    expect(ctx.state.finalizedItem).toEqual({ kind: "ticket", id: TICKET_ID, commitHash: impl });
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });
});

describe("KNOWLEDGE_REVIEW enter: evidence and its cache", () => {
  const stage = new KnowledgeReviewStage();

  it("owes nothing without a pending record: straight to COMPLETE", async () => {
    const { root, dir, base } = setup();
    expect(await stage.enter(ctxFor(root, dir, makeState(root, base, { state: "KNOWLEDGE_REVIEW" } as Partial<FullSessionState>)))).toEqual({ action: "goto", target: "COMPLETE" });
  });

  it("shows the renamed entry point as stale, first, from the ledger at the implementation commit", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl);
    const text = instructionOf(await stage.enter(ctxFor(root, dir, state)));
    expect(text).toContain(`# Knowledge review: ${ISSUE_ID}`);
    expect(text).toContain(`committed at ${impl.slice(0, 12)}`);
    expect(text).toContain(CHANGED_PATHS_DISCLOSURE);
    expect(text).toContain("src/old.ts -> src/new.ts");
    const stale = text.slice(text.indexOf("### Stale capability entries"), text.indexOf("### Capabilities matched"));
    expect(stale).toContain("cap-old");
    expect(stale).not.toContain("cap-core");
    const matched = text.slice(text.indexOf("### Capabilities matched"), text.indexOf("### Terms named"));
    expect(matched).toContain("cap-core");
    expect(text).toContain('"completedAction":"knowledge_reviewed"');
    // The rule reads an issue's title or impact (IssueSchema has no description).
    expect(text).toContain("an open issue whose title or impact names the note id");
    expect(text.indexOf("### Stale capability entries")).toBeLessThan(text.indexOf("### Capabilities matched"));
  });

  it("caches the evidence under the attempt and commit, and a resume shows the same picture", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl);
    await stage.enter(ctxFor(root, dir, state));
    const path = evidenceCachePath(dir, state.knowledgeReview!);
    expect(existsSync(path)).toBe(true);
    // A marker planted in a VALID cache for this identity is shown: the cache, not a rebuild, is what enter reads.
    const cached = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...cached, disclosure: ["cache-marker-1"] }));
    expect(instructionOf(await stage.enter(ctxFor(root, dir, state)))).toContain("cache-marker-1");
  });

  it("regenerates a cache that is invalid or carries another identity", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl);
    const path = evidenceCachePath(dir, state.knowledgeReview!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(instructionOf(await stage.enter(ctxFor(root, dir, state)))).toContain("src/old.ts -> src/new.ts");
    const rebuilt = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(rebuilt.implementationCommit).toBe(impl);

    writeFileSync(path, JSON.stringify({ ...rebuilt, itemAttemptId: "another-attempt", disclosure: ["foreign-marker"] }));
    expect(instructionOf(await stage.enter(ctxFor(root, dir, state)))).not.toContain("foreign-marker");
    writeFileSync(path, JSON.stringify({ ...rebuilt, implementationCommit: base, disclosure: ["foreign-marker"] }));
    expect(instructionOf(await stage.enter(ctxFor(root, dir, state)))).not.toContain("foreign-marker");
  });

  it("bounds a huge capability name from the ledger, and every field, list and the section of an oversized cache", async () => {
    const { root, dir, base, impl } = setup({ "cap-core": { name: "N".repeat(20_000) } });
    const state = pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl);
    const rebuilt = instructionOf(await stage.enter(ctxFor(root, dir, state)));
    const matched = rebuilt.slice(rebuilt.indexOf("### Capabilities matched"), rebuilt.indexOf("### Terms named"));
    expect(matched).toContain(`**${"N".repeat(EVIDENCE_FIELD_CHARS)}... (truncated)**`);
    expect(matched).not.toContain("N".repeat(EVIDENCE_FIELD_CHARS + 1));

    // Schema-valid caches far past every builder cap are held to the same bounds by the renderer.
    const path = evidenceCachePath(dir, state.knowledgeReview!);
    const cached = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const short = Array.from({ length: 9 }, (_, j) => `r${j}`);
    writeFileSync(path, JSON.stringify({
      ...cached,
      capabilities: Array.from({ length: 50 }, (_, i) => ({ id: `cap-${i}`, name: `n${i}`, effectiveStatus: "current", reasons: short })),
      truncated: { capabilities: false, stale: false, terms: false },
    }));
    const counted = instructionOf(await stage.enter(ctxFor(root, dir, state)));
    expect(counted).toContain(`(cap-${CAPABILITIES_CAP - 1})`);
    expect(counted).not.toContain(`(cap-${CAPABILITIES_CAP})`);
    expect(counted).toContain(`- more not shown (cap ${CAPABILITIES_CAP})`);
    expect(counted).toContain("r4; 4 more");

    const big = "x".repeat(5_000);
    writeFileSync(path, JSON.stringify({
      ...cached,
      capabilities: Array.from({ length: 200 }, (_, i) => ({ id: `cap-${i}`, name: big, effectiveStatus: big, reasons: Array(50).fill(big) })),
      stale: Array.from({ length: 200 }, (_, i) => ({ id: `cap-s${i}`, reason: big, failures: Array(50).fill(big), pendingNote: big })),
      terms: Array.from({ length: 200 }, (_, i) => ({ id: `term-${i}`, term: big, effectiveStatus: "current" })),
      rulings: Array.from({ length: 200 }, (_, i) => ({ id: `r-${i}`, lifecycle: big })),
      disclosure: Array(200).fill(big),
    }));
    const text = instructionOf(await stage.enter(ctxFor(root, dir, state)));
    const evidence = text.slice(text.indexOf("## Evidence"), text.indexOf("## Report"));
    expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(EVIDENCE_BUDGET_BYTES + 2);
    expect(evidence).toContain(`- evidence cut at the ${EVIDENCE_BUDGET_BYTES}-byte display budget`);
    expect(evidence).not.toContain("x".repeat(EVIDENCE_FIELD_CHARS + 1));
    // The report contract after the evidence is never cut.
    expect(text).toContain('"completedAction":"knowledge_reviewed"');
  });

  it("discloses a missing session start commit rather than guessing the changed paths", async () => {
    const { root, dir, base, impl } = setup();
    const noInit = makeState(root, base);
    const state = pendingAt({ ...noInit, git: { ...noInit.git, initHead: undefined } } as FullSessionState, { kind: "issue", id: ISSUE_ID }, impl);
    expect(instructionOf(await stage.enter(ctxFor(root, dir, state)))).toContain("Changed paths: unavailable (no session start commit is recorded)");
  });

  it("sanitizes a hostile attempt id into the cache filename", () => {
    const path = evidenceCachePath("/s", { itemAttemptId: "../../x y", implementationCommit: "a".repeat(40) });
    expect(path).toBe(join("/s", `knowledge-evidence-.._.._x_y-${"a".repeat(8)}.json`));
  });
});

describe("KNOWLEDGE_REVIEW report", () => {
  const stage = new KnowledgeReviewStage();

  it("accepts a verified report: the record and the acceptance are drafted for the transition's own write", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base, { itemAttempt: attempt(ISSUE_ID, "issue") } as Partial<FullSessionState>), { kind: "issue", id: ISSUE_ID }, impl);
    const ctx = ctxFor(root, dir, state);
    expect(await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) })).toEqual({ action: "goto", target: "COMPLETE" });
    expect(ctx.state.knowledgeReview?.status).toBe("accepted");
    expect(ctx.state.knowledgeImpacts).toHaveLength(1);
    const record = ctx.state.knowledgeImpacts[0]!;
    expect(record).toMatchObject({
      itemId: ISSUE_ID, kind: "issue", itemAttemptId: `att-${ISSUE_ID}`, implementationCommit: impl, headAtAcceptance: impl,
      maintenanceCommits: [], externalMaintenance: [], checkpoints: [],
    });
    expect(record.report.outcome).toBe("none");
    // Drafted, not written: nothing reached disk from the stage itself.
    expect(existsSync(join(dir, "state.json"))).toBe(false);
    const events = readFileSync(join(dir, "events.log"), "utf-8");
    expect(events).toContain("knowledge_reviewed");
  });

  it("two reports under the same (itemAttemptId, implementationCommit) store one record", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl);
    const first = ctxFor(root, dir, state);
    await stage.report(first, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    // The replayed report reaches the stage while the review still reads pending.
    const again = ctxFor(root, dir, { ...first.state, knowledgeReview: { ...first.state.knowledgeReview!, status: "pending" } } as FullSessionState);
    await stage.report(again, { completedAction: "knowledge_reviewed", knowledgeImpact: { ...noneReport(impl), reason: "second" } });
    expect(again.state.knowledgeImpacts).toHaveLength(1);
    expect(again.state.knowledgeImpacts[0]!.report.reason).toBe("second");
  });

  it("two items give two records", async () => {
    const { root, dir, base, impl } = setup();
    const first = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    await stage.report(first, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    const second = ctxFor(root, dir, pendingAt(first.state, { kind: "ticket", id: TICKET_ID }, impl));
    await stage.report(second, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    expect(second.state.knowledgeImpacts.map((r) => r.itemId)).toEqual([ISSUE_ID, TICKET_ID]);
    const section = knowledgeImpactSection(second.state, "## Knowledge impact").join("\n");
    expect(section).toContain(`### ${ISSUE_ID} (issue`);
    expect(section).toContain(`### ${TICKET_ID} (ticket`);
  });

  it("a replay after acceptance completes with no write and no second record", async () => {
    const { root, dir, base, impl } = setup();
    const first = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    await stage.report(first, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    const replay = ctxFor(root, dir, first.state);
    expect(await stage.report(replay, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) })).toEqual({ action: "goto", target: "COMPLETE" });
    expect(replay.state.knowledgeImpacts).toHaveLength(1);
    expect(replay.state.knowledgeImpacts[0]).toBe(first.state.knowledgeImpacts[0]);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("retries another action, a missing report and an invalid report, naming the path", async () => {
    const { root, dir, base, impl } = setup();
    const state = pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl);
    const other = await stage.report(ctxFor(root, dir, state), { completedAction: "commit_done" });
    expect(other.action).toBe("retry");
    expect(instructionOf(other)).toContain('KNOWLEDGE_REVIEW accepts completedAction "knowledge_reviewed"');
    const missing = await stage.report(ctxFor(root, dir, state), { completedAction: "knowledge_reviewed" });
    expect(instructionOf(missing)).toContain("knowledgeImpact is missing or invalid");
    const invalid = await stage.report(ctxFor(root, dir, state), { completedAction: "knowledge_reviewed", knowledgeImpact: { ...noneReport(impl), checked: [] } });
    expect(instructionOf(invalid)).toContain("checked: checked must name what was inspected");
    const ctx = ctxFor(root, dir, state);
    await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: { ...noneReport(impl), reason: undefined } });
    expect(ctx.state.knowledgeReview?.status).toBe("pending");
    expect(ctx.state.knowledgeImpacts).toEqual([]);
  });

  it("a refusal from the rules leaves the review pending (uncommitted ledger change)", async () => {
    const { root, dir, base, impl } = setup();
    write(root, ".story/capabilities.json", "{}\n");
    const ctx = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    const out = await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    expect(out.action).toBe("retry");
    expect(instructionOf(out)).toContain("Knowledge review not accepted:");
    expect(ctx.state.knowledgeReview?.status).toBe("pending");
    expect(ctx.state.knowledgeImpacts).toEqual([]);
  });

  it("HEAD moving between verification and the acceptance write refuses and stores nothing (rule f)", async () => {
    const { root, dir, base, impl } = setup();
    // Verification reads HEAD once; the second read is the re-read just
    // before the acceptance is persisted, and only it sees HEAD moved.
    let reads = 0;
    const moving = new KnowledgeReviewStage((r) => {
      const real = realKnowledgeGit(r);
      return { ...real, head: async () => (++reads === 2 ? { ok: true as const, data: "f".repeat(40) } : real.head()) };
    });
    const ctx = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    const out = await moving.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    expect(out.action).toBe("retry");
    expect(instructionOf(out)).toContain(`Knowledge review not accepted: HEAD moved from ${impl.slice(0, 12)} to ${"f".repeat(12)} during verification`);
    expect(reads).toBe(2);
    expect(ctx.state.knowledgeReview?.status).toBe("pending");
    expect(ctx.state.knowledgeImpacts).toEqual([]);
  });

  it("a branch reset past the implementation commit is knowledge_diverged", async () => {
    const { root, dir, base, impl } = setup();
    git(root, ["reset", "-q", "--hard", base]);
    write(root, "src/elsewhere.ts", "x\n");
    commit(root, "elsewhere");
    const ctx = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    const out = await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    expect(instructionOf(out)).toMatch(/^knowledge_diverged: /);
  });

  it("a code commit after the checkpoint is refused; knowledge_rebase moves the checkpoint and the report is then accepted", async () => {
    const { root, dir, base, impl } = setup();
    write(root, "src/a.ts", "export const a = 3;\n");
    const later = commit(root, "later code");
    const ctx = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    const refused = await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) });
    expect(instructionOf(refused)).toContain("knowledge_rebase");
    expect(ctx.state.knowledgeReview?.status).toBe("pending");

    const rebased = await stage.report(ctx, { completedAction: "knowledge_rebase" });
    expect(rebased.action).toBe("retry");
    expect(instructionOf(rebased)).toContain(`Checkpoint moved to ${later.slice(0, 12)} by knowledge_rebase; the ledger baseline is still ${impl.slice(0, 12)}.`);
    const onDisk = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
    expect(onDisk.knowledgeReview).toMatchObject({ implementationCommit: impl, checkpoint: later, checkpoints: [impl], status: "pending" });
    expect(readFileSync(join(dir, "events.log"), "utf-8")).toContain("knowledge_rebase");

    expect(await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact: noneReport(impl) })).toEqual({ action: "goto", target: "COMPLETE" });
    expect(ctx.state.knowledgeImpacts[0]!.checkpoints).toEqual([impl, later]);
    expect(ctx.state.knowledgeImpacts[0]!.implementationCommit).toBe(impl);
  });

  it("knowledge_rebase with nothing to rebase is refused and moves nothing", async () => {
    const { root, dir, base, impl } = setup();
    const ctx = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    const out = await stage.report(ctx, { completedAction: "knowledge_rebase" });
    expect(out.action).toBe("retry");
    expect(ctx.state.knowledgeReview?.checkpoint).toBe(impl);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("a maintenance commit is listed with the report and stored with it", async () => {
    const { root, dir, base, impl } = setup();
    write(root, ".story/capabilities.json", doc({ version: 1, capabilities: [
      capability("cap-core", ["src/a.ts"]),
      capability("cap-old", ["src/new.ts"], { checkedAt: { sha: impl, date: DATE } }),
    ] }));
    const m1 = commit(root, "ledger: cap-old follows the rename");
    const ctx = ctxFor(root, dir, pendingAt(makeState(root, base), { kind: "issue", id: ISSUE_ID }, impl));
    const knowledgeImpact = {
      implementationCommit: impl,
      maintenanceCommits: [m1],
      checked: ["cap-old"],
      outcome: "impacts",
      impacts: [{ record: "cap-old", kind: "stale-reference", proposed: "entry point follows the rename", disposition: "applied", evidence: { record: "cap-old" } }],
    };
    expect(await stage.report(ctx, { completedAction: "knowledge_reviewed", knowledgeImpact })).toEqual({ action: "goto", target: "COMPLETE" });
    expect(ctx.state.knowledgeImpacts[0]).toMatchObject({ headAtAcceptance: m1, maintenanceCommits: [m1] });
    expect(acceptedKnowledgeLine(ctx.state)).toBe(`Knowledge review accepted for **${ISSUE_ID}**: 1 impact: 1 applied.`);
  });
});

describe("the downstream renderer", () => {
  const impl = "c".repeat(40);
  function withRecords(records: KnowledgeImpactRecord[], extra: Partial<FullSessionState> = {}): FullSessionState {
    return { completedTickets: [{ id: "t-hash", displayId: "T-042", title: "x" }], resolvedIssueDisplayIds: { "i-hash": "ISS-007" }, knowledgeImpacts: records, knowledgeReview: null, ...extra } as unknown as FullSessionState;
  }
  function rec(overrides: Partial<KnowledgeImpactRecord>, report: Record<string, unknown>): KnowledgeImpactRecord {
    return {
      itemId: "t-hash", kind: "ticket", itemAttemptId: "att", implementationCommit: impl, headAtAcceptance: impl,
      maintenanceCommits: [], externalMaintenance: [], checkpoints: [], acceptedAt: "2026-09-22T00:00:00.000Z",
      report: { implementationCommit: impl, maintenanceCommits: [], checked: ["cap-a"], ...report } as KnowledgeImpactRecord["report"],
      ...overrides,
    };
  }

  it("renders no section without accepted reviews", () => {
    expect(knowledgeImpactSection(withRecords([]), "## Knowledge impact")).toEqual([]);
  });

  it("puts needs-decision under awaiting the owner, uncertain as an open question, and names rebases, maintenance and external work", () => {
    const m1 = "d".repeat(40);
    const state = withRecords([
      rec({ checkpoints: [impl, "e".repeat(40)], maintenanceCommits: [m1], externalMaintenance: [{ id: "cap-z", commit: "f".repeat(40) }] }, {
        outcome: "impacts",
        impacts: [
          { record: "cap-a", kind: "stale-reference", proposed: "follow the rename", disposition: "applied", evidence: { record: "cap-a" } },
          { record: "N-1", kind: "stale-reference", proposed: "note names the old path", disposition: "pending", evidence: { record: "N-1", issueId: "ISS-9" } },
          { record: "r-0000000000000001", kind: "ruling-conflict", proposed: "logging moved", disposition: "needs-decision", evidence: { record: "r-0000000000000001", proposalId: "r-0000000000000002" } },
        ],
      }),
      rec({ itemId: "i-hash", kind: "issue", itemAttemptId: "att2" }, { outcome: "uncertain", reason: "not sure the glossary covers this" }),
    ], { contextManifests: { "t-hash": { current: "t-hash-2", generation: 2, outstanding: [], recovery: { reasons: ["ruling R1 unreadable"], raisedAt: "2026-09-22T00:00:00.000Z" }, planApprovalInvalidated: null } } } as Partial<FullSessionState>);
    const text = knowledgeImpactSection(state, "## Knowledge impact").join("\n");
    expect(text).toContain(`### T-042 (ticket, committed at ${impl.slice(0, 12)})`);
    expect(text).toContain("- Outcome: **3 impacts: 1 applied, 1 pending, 1 awaiting the owner**");
    expect(text).toContain("  - cap-a (stale-reference): applied. follow the rename");
    expect(text).toContain("  - N-1 (stale-reference): pending, follow-up ISS-9. note names the old path");
    const awaiting = text.slice(text.indexOf("- Awaiting the owner:"));
    expect(awaiting).toContain("r-0000000000000001 (ruling-conflict): proposal r-0000000000000002. logging moved");
    expect(text).toContain(`- Rebased (knowledge_rebase): ${impl.slice(0, 12)} -> ${"e".repeat(12)}`);
    expect(text).toContain(`- Maintenance commits: ${m1.slice(0, 12)}`);
    expect(text).toContain(`- External maintenance (not this session's): cap-z in ${"f".repeat(12)}`);
    expect(text).toContain("- Context brief recovery: ruling R1 unreadable");
    expect(text).toContain("### ISS-007 (issue");
    expect(text).toContain("- Open question: not sure the glossary covers this");
  });

  it("escapes what came out of state.json", () => {
    const state = withRecords([rec({}, { outcome: "none", reason: "see [here](https://x.test)\n# forged heading <img src=x>" })]);
    const text = knowledgeImpactSection(state, "## Knowledge impact").join("\n");
    expect(text).not.toContain("](https://x.test)");
    expect(text).not.toContain("\n# forged");
    expect(text).not.toContain("<img");
  });

  it("bounds the items shown and says where the rest are", () => {
    const records = Array.from({ length: 23 }, (_, i) => rec({ itemAttemptId: `att-${i}` }, { outcome: "none", reason: `r${i}` }));
    const text = knowledgeImpactSection(withRecords(records), "## Knowledge impact").join("\n");
    expect(text).toContain("3 earlier review(s) not shown (23 total).");
    expect(text).not.toContain("Reason: r0\n");
    expect(text).toContain("Reason: r22");
  });

  it("bounds every inline list and the whole section: thousands of checked entries in an accepted none report", () => {
    const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
    const hex = (i: number) => i.toString(16).padStart(40, "0");
    const big = rec({
      checkpoints: many(30, hex), maintenanceCommits: many(30, hex), externalMaintenance: many(30, (i) => ({ id: `cap-e${i}`, commit: hex(i) })),
    }, { outcome: "none", reason: "r", checked: many(5_000, (i) => `cap-c${i}`) });
    const one = knowledgeImpactSection(withRecords([big]), "## Knowledge impact").join("\n");
    expect(one).toContain(`- Checked: cap-c0, cap-c1, `);
    expect(one).toContain(`cap-c${KNOWLEDGE_INLINE_SHOWN - 1} (and ${5_000 - KNOWLEDGE_INLINE_SHOWN} more; 5000 total). The complete list is in`);
    expect(one).not.toContain(`cap-c${KNOWLEDGE_INLINE_SHOWN},`);
    // Rebases, maintenance commits and external maintenance are each bounded the same way.
    expect(one.split(`(and ${30 - KNOWLEDGE_INLINE_SHOWN} more; 30 total)`).length - 1).toBe(3);

    // Twenty items with every string at its cap and every list full still fit the section budget.
    const long = "y".repeat(1_000);
    const records = many(20, (i) => rec({ itemAttemptId: `att-${i}`, checkpoints: many(30, hex), maintenanceCommits: many(30, hex) }, {
      outcome: "impacts",
      checked: many(50, () => long),
      impacts: many(20, () => ({ record: "cap-a", kind: "stale-reference", proposed: long, disposition: "applied", evidence: { record: "cap-a" } })),
    }));
    const all = knowledgeImpactSection(withRecords(records), "## Knowledge impact").join("\n");
    expect(Buffer.byteLength(all, "utf8")).toBeLessThanOrEqual(KNOWLEDGE_SECTION_BUDGET_BYTES);
    expect(all).toContain(`Section cut at the ${KNOWLEDGE_SECTION_BUDGET_BYTES}-byte budget. The complete list is in`);
  });

  it("COMPLETE's line names only the review just accepted", () => {
    const record = rec({}, { outcome: "uncertain", reason: "r" });
    const review = { itemId: "t-hash", kind: "ticket", itemAttemptId: "att", implementationCommit: impl, checkpoint: impl, status: "accepted" };
    expect(acceptedKnowledgeLine(withRecords([record], { knowledgeReview: review } as Partial<FullSessionState>)))
      .toBe("Knowledge review accepted for **T-042**: uncertain. It is an open question in the handover.");
    expect(acceptedKnowledgeLine(withRecords([record], { knowledgeReview: { ...review, status: "pending" } } as Partial<FullSessionState>))).toBeNull();
    expect(acceptedKnowledgeLine(withRecords([record], { knowledgeReview: { ...review, itemAttemptId: "other" } } as Partial<FullSessionState>))).toBeNull();
    const other = "e".repeat(40);
    expect(acceptedKnowledgeLine(withRecords([record], { knowledgeReview: { ...review, implementationCommit: other, checkpoint: other } } as Partial<FullSessionState>))).toBeNull();
    // Two records under one attempt: the line is the accepted commit's.
    const older = rec({ implementationCommit: other }, { outcome: "none", reason: "older" });
    expect(acceptedKnowledgeLine(withRecords([older, record], { knowledgeReview: review } as Partial<FullSessionState>)))
      .toBe("Knowledge review accepted for **T-042**: uncertain. It is an open question in the handover.");
    expect(acceptedKnowledgeLine(withRecords([record, older], { knowledgeReview: { ...review, implementationCommit: other, checkpoint: other } } as Partial<FullSessionState>)))
      .toBe("Knowledge review accepted for **T-042**: none.");
  });
});
