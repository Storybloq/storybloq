/**
 * ISS-1282: the bridge receipt gate, wired into both review stages.
 *
 * Real git repositories, because the gate's evidence is git's own numstat: an
 * item repo whose working tree is the item diff, and a review clone holding the
 * range the reviewer was given. Identity is passed per command (`-c`), never
 * written to a config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { agentFallbackLines, GATE_ESCAPE_AT, GATE_UNAVAILABLE_AT } from "../../../src/autonomous/stages/review-gate.js";
import { RECEIPT_ATTESTATION } from "../../../src/autonomous/review-gate-receipt.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { BRIDGE_REVIEW_MODEL } from "../helpers/bridge-receipts.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const sha256 = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n";
const ASTRA = BRIDGE_REVIEW_MODEL;
const GEMINI = { ...ASTRA, provider: "gemini", resolved: "Gemini 3.1 Pro (High)", observed: "Gemini 3.1 Pro (High)" };

function makeState(root: string, mergeBase: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "CODE_REVIEW",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase, expectedHead: mergeBase },
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
    guideCallCount: 1,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null,
    resolvedIssues: [],
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    landingDecision: null,
    currentReviewStartedAt: now,
    reviewRepairAttempts: [],
    reviewGateRefusals: [],
    ...overrides,
  } as FullSessionState;
}

const RECIPE: ResolvedRecipe = {
  id: "coding",
  pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
  postComplete: [],
  stages: { CODE_REVIEW: { maxReviewRounds: 3 } },
  dirtyFileHandling: "block",
  branchStrategy: "current",
  defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
};

function writeConfig(root: string, reviewGate?: unknown): void {
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...(reviewGate === undefined ? {} : { recipeOverrides: { reviewGate } }),
  }));
}

function writeRuling(root: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, ".story", "rulings"), { recursive: true });
  writeFileSync(join(root, ".story", "rulings", `${id}.json`), JSON.stringify({
    attribution: "owner-direct", createdAt: "2026-09-06T18:12:00.000Z", date: "2026-09-06", id,
    recordedBy: { client: "claude", id: "6bd82ca1" }, scopeTags: ["review"], supersedes: null,
    text: "Gemini 3.1 Pro may satisfy review gates under the Codex cap", ...extra,
  }));
}

const artifacts = (dir: string): number => {
  const d = join(dir, "telemetry", "reviews");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).length : 0;
};

describe("ISS-1282 bridge receipt gate", () => {
  let root: string;
  let clone: string;
  let sessionDir: string;
  let base: string;
  let reviewBase: string;
  let reviewHead: string;
  const savedClient = process.env.STORYBLOQ_CLIENT;

  beforeEach(() => {
    delete process.env.STORYBLOQ_CLIENT;
    root = mkdtempSync(join(tmpdir(), "iss1282-item-"));
    for (const d of ["tickets", "issues", "notes", "lessons", "handovers"]) mkdirSync(join(root, ".story", d), { recursive: true });
    writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({ title: "t", date: "2026-09-26", phases: [{ id: "p1", label: "P1", name: "P", description: "d" }], blockers: [] }));
    writeConfig(root);
    writeFileSync(join(root, ".gitignore"), ".story/sessions/\n");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    base = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "a.ts"), TEN); // the item: one untracked file, 10 lines
    sessionDir = join(root, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });

    clone = mkdtempSync(join(tmpdir(), "iss1282-clone-"));
    git(clone, "init", "-q");
    writeFileSync(join(clone, "README"), "x\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "synthetic base");
    reviewBase = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(clone, "a.ts"), TEN);
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "item");
    reviewHead = git(clone, "rev-parse", "HEAD");
  });

  afterEach(() => {
    if (savedClient === undefined) delete process.env.STORYBLOQ_CLIENT; else process.env.STORYBLOQ_CLIENT = savedClient;
    rmSync(root, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  /** One bridge call's receipt, carrying that call's models[] and session id. */
  const call = (b: string, h: string, receipt: string, models: unknown = [ASTRA], sessionId = "bridge-1") => ({ cwd: clone, base: b, head: h, receipt, models, sessionId });
  /**
   * `models` null omits the call's models[] altogether. Removed after
   * construction: passing `undefined` to `call` would take its valid default.
   */
  const codeReport = (extra: Record<string, unknown> = {}, models: unknown[] | null = [ASTRA]) => {
    const receipt: Record<string, unknown> = call(reviewBase, reviewHead, "REVIEWED: a.ts (~10 changed lines)", models ?? [ASTRA]);
    if (models === null) delete receipt.models;
    return { completedAction: "code_review_round", verdict: "approve", findings: [], reviewer: "codex", reviewReceipts: [receipt], ...extra };
  };

  it("the helper's null models really omits them", () => {
    const receipt = codeReport({}, null).reviewReceipts[0]!;
    expect(receipt.models).toBeUndefined();
    expect("models" in receipt).toBe(false);
  });

  it("refuses a bridge report with no model receipt before any sink, and records the refusal", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({}, null));
    expect(r).toMatchObject({ action: "retry" });
    expect((r as { instruction: string }).instruction).toContain("No round was recorded");
    expect((r as { instruction: string }).instruction).toContain('tier: "max"');
    expect((r as { instruction: string }).instruction).toContain(RECEIPT_ATTESTATION);
    expect(ctx.state.reviews.code).toHaveLength(0);
    expect(artifacts(sessionDir)).toBe(0);
    expect(ctx.state.pendingReviewAttempt ?? null).toBeNull();
    expect(ctx.state.reviewRepairAttempts).toHaveLength(0);
    expect(ctx.state.reviewGateRefusals).toEqual([
      expect.objectContaining({ workItemId: "T-001", kind: "ticket", stage: "code", round: 1, reason: expect.stringContaining("reviewReceipts[0].models: no bridge model receipt") }),
    ]);
  });

  it("refuses a receipt for a range that does not cover the item", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    writeFileSync(join(root, "b.ts"), TEN);
    const r = await new CodeReviewStage().report(ctx, codeReport());
    expect((r as { instruction: string }).instruction).toContain("not reviewed: b.ts");
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("refuses a range of the same shape whose bytes are not the item's", async () => {
    writeFileSync(join(clone, "a.ts"), TEN.replace("line 3", "line X"));
    git(clone, "commit", "-qam", "other bytes");
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({
      reviewReceipts: [call(reviewBase, git(clone, "rev-parse", "HEAD"), "REVIEWED: a.ts (~10 changed lines)")],
    }));
    expect((r as { instruction: string }).instruction).toContain("stale review: the last review of a.ts does not end where the working tree is");
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("an item split across two ranges passes when the last head holds the working-tree bytes", async () => {
    writeFileSync(join(clone, "a.ts"), TEN.split("\n").slice(0, 5).join("\n") + "\n");
    git(clone, "commit", "-qam", "part A");
    const partA = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(clone, "a.ts"), TEN);
    git(clone, "commit", "-qam", "part B");
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({
      reviewReceipts: [
        call(reviewBase, partA, "REVIEWED: a.ts (~5 changed lines)"),
        call(partA, git(clone, "rev-parse", "HEAD"), "REVIEWED: a.ts (~5 changed lines)", [ASTRA], "bridge-2"),
      ],
    }));
    expect(r).not.toMatchObject({ action: "retry" });
    expect(ctx.state.reviews.code).toHaveLength(1);
  });

  it("an untracked symlink counts as its target text and binds to the reviewed link", async () => {
    symlinkSync("a.ts", join(root, "link.ts"));
    symlinkSync("a.ts", join(clone, "link.ts"));
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "link");
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({
      reviewReceipts: [call(reviewBase, git(clone, "rev-parse", "HEAD"), "REVIEWED: [range] (~11 changed lines)")],
    }));
    expect(r).not.toMatchObject({ action: "retry" });
    expect(ctx.state.reviews.code).toHaveLength(1);
  });

  it("an unreadable untracked file refuses instead of passing as an exempt binary", async () => {
    writeFileSync(join(root, "secret.ts"), TEN);
    chmodSync(join(root, "secret.ts"), 0o000);
    try {
      const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
      const r = await new CodeReviewStage().report(ctx, codeReport());
      expect((r as { instruction: string }).instruction).toContain("could not read the item diff: untracked secret.ts is unreadable");
    } finally {
      chmodSync(join(root, "secret.ts"), 0o600);
    }
  });

  it("names the agent escape from the third refusal and marks codex unavailable at the fifth", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const stage = new CodeReviewStage();
    const bad = codeReport({}, [{ ...ASTRA, selection: "provider_default" }]);
    const texts: string[] = [];
    for (let i = 1; i <= GATE_UNAVAILABLE_AT; i++) texts.push(((await stage.report(ctx, bad)) as { instruction: string }).instruction);
    expect(texts[GATE_ESCAPE_AT - 2]).not.toContain('reviewer: "agent"');
    expect(texts[GATE_ESCAPE_AT - 1]).toContain('reviewer: "agent"');
    expect(texts[GATE_UNAVAILABLE_AT - 2]).not.toContain("now marked unavailable");
    expect(texts[GATE_UNAVAILABLE_AT - 1]).toContain("now marked unavailable");
    expect(ctx.state.codexUnavailable).toBe(true);
    expect(typeof ctx.state.codexUnavailableSince).toBe("string");
    expect(ctx.state.reviewGateRefusals).toHaveLength(GATE_UNAVAILABLE_AT);
  });

  it("accepts a proven receipt and records observed provenance and the refusals before it", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const stage = new CodeReviewStage();
    await stage.report(ctx, codeReport({ reviewReceipts: [] }));
    const r = await stage.report(ctx, codeReport({ reviewerModel: "made-up", reviewerEvidence: "configured" }));
    expect(r).not.toMatchObject({ action: "retry" });
    const rec = ctx.state.reviews.code[0] as unknown as Record<string, unknown>;
    expect(rec.reviewGate).toEqual({ observed: [{ provider: "codex", model: "gpt-6-astra" }] });
    expect(rec.gateRefusalsBeforeAccept).toBe(1);
    expect(rec.reviewerIdentity).toMatchObject({ model: "gpt-6-astra", tier: "max", evidence: "observed" });
    expect(artifacts(sessionDir)).toBe(1);
  });

  it("refuses Gemini without a ruling, and names a withdrawn one", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const stage = new CodeReviewStage();
    let r = await stage.report(ctx, codeReport({}, [GEMINI]));
    expect((r as { instruction: string }).instruction).toContain("no accepted owner ruling");
    writeRuling(root, "r-4444444444444444", { status: "withdrawn", proposesToSupersede: null, proposedFor: [] });
    writeConfig(root, { geminiRuling: "r-4444444444444444" });
    r = await stage.report(ctx, codeReport({}, [GEMINI]));
    expect((r as { instruction: string }).instruction).toContain("ruling r-4444444444444444 is withdrawn");
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("refuses Gemini under a superseded ruling (fails closed on the successor, not effectively-accepted)", async () => {
    writeRuling(root, "r-5555555555555555");
    writeRuling(root, "r-6666666666666666", { supersedes: "r-5555555555555555", createdAt: "2026-09-07T18:12:00.000Z", date: "2026-09-07" });
    writeConfig(root, { geminiRuling: "r-5555555555555555" });
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({}, [GEMINI]));
    expect((r as { instruction: string }).instruction).toContain("ruling r-5555555555555555 is superseded");
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("ledger changes under .story/ are not part of the item the review must cover", async () => {
    writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({ title: "changed", date: "2026-09-26", phases: [], blockers: [] }));
    writeFileSync(join(root, ".story", "notes", "n-new.json"), "{}\n");
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport());
    expect(r).not.toMatchObject({ action: "retry" });
    expect(ctx.state.reviews.code).toHaveLength(1);
  });

  it("accepts Gemini under an accepted ruling and records the disclosure", async () => {
    writeRuling(root, "r-5555555555555555");
    writeConfig(root, { geminiRuling: "r-5555555555555555" });
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    await new CodeReviewStage().report(ctx, codeReport({}, [GEMINI]));
    const rec = ctx.state.reviews.code[0] as unknown as Record<string, unknown>;
    expect(rec.reviewGate).toEqual({ observed: [{ provider: "gemini", model: "Gemini 3.1 Pro (High)" }], disclosure: "gemini-under-owner-ruling" });
  });

  it("leaves agent rounds ungated, and an agent round after refusals is named at FINALIZE", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const stage = new CodeReviewStage();
    await stage.report(ctx, codeReport({}, null));
    await stage.report(ctx, codeReport({}, null));
    const r = await stage.report(ctx, { completedAction: "code_review_round", verdict: "approve", findings: [], reviewer: "agent", notes: "codex unavailable: bridge not gate-grade" });
    expect(r).not.toMatchObject({ action: "retry" });
    const rec = ctx.state.reviews.code[0] as unknown as Record<string, unknown>;
    expect(rec.reviewer).toBe("agent");
    expect(rec.reviewGate).toBeUndefined();
    expect(rec.gateRefusalsBeforeAccept).toBe(2);
    expect(rec.gateFallback).toEqual({ reason: "bridge-refusals", sessionRefusals: 2 });
    expect(agentFallbackLines(ctx.state)).toEqual(["Code review gate satisfied by agent fallback after 2 refused bridge reports in this session."]);
    ctx.writeState({ state: "FINALIZE", finalizeCheckpoint: null });
    const fin = await new FinalizeStage().enter(ctx);
    expect((fin as { instruction: string }).instruction).toContain("Code review gate satisfied by agent fallback after 2 refused bridge reports in this session.");
    ctx.writeState({ finalizeCheckpoint: "staged" });
    const commit = await new FinalizeStage().report(ctx, { completedAction: "files_staged" });
    expect((commit as { instruction: string }).instruction).toContain('Include in the commit body: "Code review gate satisfied by agent fallback after 2 refused bridge reports in this session."');
  });

  it("an agent round after the cutoff is disclosed even with no refusal on its own round", async () => {
    const other = (workItemId: string, round: number) => ({ workItemId, kind: "ticket" as const, stage: "code" as const, round, reason: "x", at: new Date().toISOString() });
    const refusals = [other("T-000", 1), other("T-000", 2), other("T-009", 1), other("T-009", 2), other("T-010", 1)];
    const ctx = new StageContext(root, sessionDir, makeState(root, base, {
      reviewGateRefusals: refusals, codexUnavailable: true, codexUnavailableSince: new Date().toISOString(),
    }), RECIPE);
    const r = await new CodeReviewStage().report(ctx, { completedAction: "code_review_round", verdict: "approve", findings: [], reviewer: "agent" });
    expect(r).not.toMatchObject({ action: "retry" });
    const rec = ctx.state.reviews.code[0] as unknown as Record<string, unknown>;
    expect(rec.gateRefusalsBeforeAccept).toBeUndefined();
    expect(rec.gateFallback).toEqual({ reason: "codex-unavailable", sessionRefusals: 5 });
    expect(agentFallbackLines(ctx.state)).toEqual(["Code review gate satisfied by agent fallback: Codex was marked unavailable (5 refused bridge reports in this session)."]);
  });

  it("an agent round the rotation chose, with Codex available and nothing refused, is no fallback", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    await new CodeReviewStage().report(ctx, { completedAction: "code_review_round", verdict: "approve", findings: [], reviewer: "agent" });
    const rec = ctx.state.reviews.code[0] as unknown as Record<string, unknown>;
    expect(rec.gateFallback).toBeUndefined();
    expect(agentFallbackLines(ctx.state)).toEqual([]);
  });

  it("names no agent fallback when a bridge round, not an agent round, passed after refusals", () => {
    const state = { reviews: { plan: [], code: [{ reviewer: "codex", gateRefusalsBeforeAccept: 2 }] } } as unknown as Parameters<typeof agentFallbackLines>[0];
    expect(agentFallbackLines(state)).toEqual([]);
  });

  it("leaves the native Codex client path ungated", async () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, { completedAction: "code_review_round", verdict: "approve", findings: [], reviewer: "codex" });
    expect(r).not.toMatchObject({ action: "retry" });
    expect(ctx.state.reviewGateRefusals ?? []).toHaveLength(0);
  });

  it("PLAN_REVIEW: refuses a receipt for a different plan, accepts the matching one", async () => {
    writeFileSync(join(sessionDir, "plan.md"), TEN);
    const ctx = new StageContext(root, sessionDir, makeState(root, base, { state: "PLAN_REVIEW" }), RECIPE);
    const stage = new PlanReviewStage();
    const plan = (receipt: string) => ({ completedAction: "plan_review_round", verdict: "approve", findings: [], reviewer: "codex", reviewReceipts: { receipt, planSha256: sha256(TEN), models: [ASTRA], sessionId: "bridge-1" } });
    const r = await stage.report(ctx, plan("REVIEWED: plan.md (~40 lines)"));
    expect((r as { instruction: string }).instruction).toContain("plan.md has 10");
    expect(ctx.state.reviews.plan).toHaveLength(0);
    expect(ctx.state.reviewGateRefusals?.[0]).toMatchObject({ stage: "plan", round: 1 });
    await stage.report(ctx, plan("REVIEWED: plan.md (~10 lines)"));
    const rec = ctx.state.reviews.plan[0] as unknown as Record<string, unknown>;
    expect(rec.reviewGate).toEqual({ observed: [{ provider: "codex", model: "gpt-6-astra" }] });
    expect(rec.gateRefusalsBeforeAccept).toBe(1);
  });
  it("refuses a receipt of the same count on a base that does not hold the item's baseline bytes", async () => {
    // fakeBase..HEAD changes a.ts by exactly the 5 lines it names and ends at the working tree,
    // but a.ts is new in the item: no review that starts from half of it covers the item.
    writeFileSync(join(clone, "a.ts"), TEN.split("\n").slice(0, 5).join("\n") + "\n");
    git(clone, "commit", "-qam", "fake base");
    const fakeBase = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(clone, "a.ts"), TEN);
    git(clone, "commit", "-qam", "rest");
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({ reviewReceipts: [call(fakeBase, git(clone, "rev-parse", "HEAD"), "REVIEWED: a.ts (~5 changed lines)")] }));
    expect((r as { instruction: string }).instruction).toContain(`unrelated base: reviewReceipts[0] reviews a.ts from ${fakeBase}, which does not hold it as the item baseline ${base} does`);
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("refuses the same range reviewed twice", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({
      reviewReceipts: [call(reviewBase, reviewHead, "REVIEWED: a.ts (~10 changed lines)"), call(reviewBase, reviewHead, "REVIEWED: a.ts (~10 changed lines)", [ASTRA], "bridge-2")],
    }));
    expect((r as { instruction: string }).instruction).toContain("broken review chain for a.ts: reviewReceipts[1]");
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("two receipts, one without gate-grade evidence of its own: refused", async () => {
    writeFileSync(join(clone, "a.ts"), TEN.split("\n").slice(0, 5).join("\n") + "\n");
    git(clone, "commit", "-qam", "part A");
    const partA = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(clone, "a.ts"), TEN);
    git(clone, "commit", "-qam", "part B");
    const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport({
      reviewReceipts: [
        call(reviewBase, partA, "REVIEWED: a.ts (~5 changed lines)"),
        call(partA, git(clone, "rev-parse", "HEAD"), "REVIEWED: a.ts (~5 changed lines)", [{ ...ASTRA, observed: null, evidence: "bridge_selection" }], "bridge-2"),
      ],
    }));
    expect((r as { instruction: string }).instruction).toContain("reviewReceipts[1].models: observed is null");
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("refuses when the session recorded no baseline for the item", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base, { git: { branch: "main", mergeBase: null } as FullSessionState["git"] }), RECIPE);
    const r = await new CodeReviewStage().report(ctx, codeReport());
    expect((r as { instruction: string }).instruction).toContain("the session recorded no baseline commit for this item");
  });

  it("falls back to the item's start commit when there is no merge base, and names it in the rules", async () => {
    const ctx = new StageContext(root, sessionDir, makeState(root, base, { git: { branch: "main", mergeBase: null, itemBaseHead: base } as FullSessionState["git"] }), RECIPE);
    const refused = await new CodeReviewStage().report(ctx, codeReport({}, null));
    expect((refused as { instruction: string }).instruction).toContain(`Chain the ranges from the item baseline \`${base}\``);
    const r = await new CodeReviewStage().report(ctx, codeReport());
    expect(r).not.toMatchObject({ action: "retry" });
  });

  it("escalation counts the session: refusals spread across items and stages reach the fallback and the cutoff", async () => {
    const other = (workItemId: string, stage: "code" | "plan", round: number) => ({ workItemId, kind: "ticket" as const, stage, round, reason: "x", at: new Date().toISOString() });
    const ctx = new StageContext(root, sessionDir, makeState(root, base, { reviewGateRefusals: [other("T-000", "plan", 1), other("T-000", "code", 2)] }), RECIPE);
    const stage = new CodeReviewStage();
    const third = ((await stage.report(ctx, codeReport({}, null))) as { instruction: string }).instruction;
    expect(third).toContain("This session has 3 refused bridge reports");
    expect(third).toContain('reviewer: "agent"');
    ctx.writeState({ reviewGateRefusals: [...ctx.state.reviewGateRefusals, other("T-009", "plan", 1)] });
    const fifth = ((await stage.report(ctx, codeReport({}, null))) as { instruction: string }).instruction;
    expect(fifth).toContain("now marked unavailable after 5 refused bridge reports in this session");
    expect(ctx.state.codexUnavailable).toBe(true);
    // The record still counts only this round's own refusals.
    ctx.writeState({ codexUnavailable: false });
    await stage.report(ctx, codeReport());
    expect((ctx.state.reviews.code[0] as unknown as Record<string, unknown>).gateRefusalsBeforeAccept).toBe(2);
  });

  it("an unreadable untracked file under .story/ cannot reject a valid review", async () => {
    const hidden = join(root, ".story", "notes", "n-locked.json");
    writeFileSync(hidden, "{}\n");
    chmodSync(hidden, 0o000);
    try {
      const ctx = new StageContext(root, sessionDir, makeState(root, base), RECIPE);
      const r = await new CodeReviewStage().report(ctx, codeReport());
      expect(r).not.toMatchObject({ action: "retry" });
      expect(ctx.state.reviews.code).toHaveLength(1);
    } finally {
      chmodSync(hidden, 0o600);
    }
  });

  it("PLAN_REVIEW: a receipt reused after the plan was replaced by different text of equal length is refused", async () => {
    writeFileSync(join(sessionDir, "plan.md"), TEN);
    const ctx = new StageContext(root, sessionDir, makeState(root, base, { state: "PLAN_REVIEW" }), RECIPE);
    const receipt = { receipt: "REVIEWED: plan.md (~10 lines)", planSha256: sha256(TEN), models: [ASTRA], sessionId: "bridge-1" };
    writeFileSync(join(sessionDir, "plan.md"), TEN.replace("line 3", "line Q"));
    const r = await new PlanReviewStage().report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [], reviewer: "codex", reviewReceipts: receipt });
    expect((r as { instruction: string }).instruction).toContain("plan receipt digest does not match plan.md");
    expect(ctx.state.reviews.plan).toHaveLength(0);
  });
});
