/**
 * T-525: the continuity deterministic suite. Cases assert structure through
 * the REAL path (F-B): the validate handler, the citation packet, the guide's
 * own PLAN instruction. Cases whose feature has not landed are named here as
 * todo with the owning ticket; that ticket records the RED evidence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProject } from "../../src/core/project-loader.js";
import { handleValidate } from "../../src/cli/commands/validate.js";
import { handleExport } from "../../src/cli/commands/export.js";
import { citationsForReviewTarget } from "../../src/autonomous/cited-rulings.js";
import { guardPlanNamesCitedRulings } from "../../src/autonomous/plan-pin-guard.js";
import { loadRulingsSafe } from "../../src/core/ruling-loader.js";
import { buildSuccessorIndex, buildCitationResolutionContext, resolveCitation } from "../../src/core/ruling.js";
import { classifyLifecycle, payloadDigest } from "../../src/core/ruling-lifecycle.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { RulingSchema } from "../../src/models/ruling.js";
import { handleRulingAccept, handleRulingGet, handleRulingList, handleRulingPropose } from "../../src/cli/commands/ruling.js";
import * as oracle from "../core/oracle-1-15/ruling-655b03bf.js";
import { RulingSchema as OldRulingSchema } from "../core/oracle-1-15/ruling-schema-655b03bf.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { buildContextBrief, NO_PATHS_NAMED } from "../../src/autonomous/context-brief.js";
import { PLAN_REVIEWER_CHECKS } from "../../src/autonomous/plan-context.js";
import { StageContext } from "../../src/autonomous/stages/types.js";
import { PlanStage } from "../../src/autonomous/stages/plan.js";
import { PickTicketStage } from "../../src/autonomous/stages/pick-ticket.js";
import { CodeReviewStage } from "../../src/autonomous/stages/code-review.js";
import { resolveRecipe } from "../../src/autonomous/recipes/loader.js";
import { createSession, prepareForCompact, readSession, sessionDir, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { handleCapabilityDefer } from "../../src/cli/commands/capability.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import type { CommandContext } from "../../src/cli/types.js";
import { materialize, hashTree, TASKS } from "../../scripts/continuity-lib.js";
import { killSidecarsInRoot } from "../autonomous/_sidecar-cleanup.js";

const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const MAP = JSON.parse(readFileSync(join(FIXTURE, "fixture-map.json"), "utf-8")) as { rulings: Record<string, string> };
const FACTS = JSON.parse(readFileSync(join(FIXTURE, "facts.json"), "utf-8")) as { facts: { id: string; text: string; carriers: Record<string, string[]> }[]; arm2MustNotContain: string[] };

const roots: string[] = [];
function copy(arm: 1 | 2 | 3, task: (typeof TASKS)[number] = "T-2.a", git = false, prepare?: (dest: string) => void): string {
  const dest = mkdtempSync(join(tmpdir(), "continuity-e2e-"));
  materialize(FIXTURE, arm, task, dest);
  prepare?.(dest);
  if (git) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const g = (args: string[]): void => { execFileSync("git", args, { cwd: dest, env, stdio: "ignore" }); };
    g(["init", "-q", "-b", "main"]); g(["config", "user.name", "t"]); g(["config", "user.email", "t@t.t"]); g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  }
  roots.push(dest);
  return dest;
}
afterEach(() => { for (const r of roots.splice(0)) { killSidecarsInRoot(r); rmSync(r, { recursive: true, force: true }); } });

/** Copies overlays/lifecycle/.story (R4, the proposal against R1) over a materialised core. */
function withLifecycle(root: string): string {
  cpSync(join(FIXTURE, "overlays", "lifecycle", ".story"), join(root, ".story"), { recursive: true });
  return root;
}
const CALLER = "continuity-suite";

async function ctxFor(root: string): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" };
}

describe("continuity case 0: fixture", () => {
  it("0a the core validates clean through the real validate handler", async () => {
    const out = handleValidate(await ctxFor(copy(1))).output;
    expect(out).toMatch(/Errors: 0/);
    expect(out).not.toMatch(/ERROR/);
  });

  it("0b every behavioural fact is carried in every arm; arm 2 has no catalogs (P-1)", () => {
    const arm2 = copy(2);
    for (const f of FACTS.arm2MustNotContain) expect(existsSync(join(arm2, f))).toBe(false);
    // Arm 3's catalogs landed with T-526 (overlays/arm3/.story); every declared arm-3 carrier is checked like the others.
    const arms: readonly (1 | 2 | 3)[] = [1, 2, 3];
    for (const arm of arms) {
      const root = arm === 2 ? arm2 : copy(arm);
      for (const fact of FACTS.facts) {
        const carriers = fact.carriers[`arm${arm}`] ?? [];
        expect(carriers.length, `${fact.id} has no arm ${arm} carrier`).toBeGreaterThan(0);
        for (const carrier of carriers) {
          expect(existsSync(join(root, carrier)), `${carrier} exists in arm ${arm}`).toBe(true);
          expect(readFileSync(join(root, carrier), "utf-8"), `${fact.id} in ${carrier} (arm ${arm})`).toContain(fact.text);
        }
      }
    }
  });

  it("0c the materialised working copy is the core plus the variant, nothing else", () => {
    const dest = copy(1, "T-2.b");
    const core = hashTree(join(FIXTURE, "core"));
    const made = hashTree(dest);
    expect(made.files).toEqual(core.files);
    const differing = core.files.filter((f) => !readFileSync(join(FIXTURE, "core", f)).equals(readFileSync(join(dest, f))));
    expect(differing).toEqual([".story/tickets/T-2.json"]);
    const t2 = JSON.parse(readFileSync(join(dest, ".story/tickets/T-2.json"), "utf-8")) as { description: string };
    expect(t2.description).not.toMatch(/src\//);
  });
});

describe("continuity cases 4 and 5: compatibility (green today, pinned)", () => {
  it("4 a citation of the superseded R5 resolves forward to R1 with R1's wording through the packet path", async () => {
    const root = copy(1);
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [MAP.rulings.R5] }, null, 2));
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.citations).toHaveLength(1);
    const c = res.citations[0]!;
    expect(c.status).toBe("resolved");
    if (c.status !== "resolved") return;
    expect(c.citedId).toBe(MAP.rulings.R5);
    expect(c.stale).toBe(true);
    expect(c.current.id).toBe(MAP.rulings.R1);
    expect(c.chain).toEqual([MAP.rulings.R5, MAP.rulings.R1]);
    expect(c.current.text).toContain("Logging keeps redaction and request ids on every path");
    expect(c.current.text).not.toContain("every line has the request id on it");
  });

  it("5 the unrelated ruling R3 reaches neither the PLAN instruction nor the context digest", async () => {
    const root = copy(1, "T-2.a", true);
    const result = await handleAutonomousGuide(root, { sessionId: null, action: "start", mode: "plan", ticketId: "T-2" } as never);
    const text = (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
    expect(text).toMatch(/\*\*State:\*\*\s*PLAN/);
    expect(text).not.toContain(MAP.rulings.R3);
    expect(text).not.toContain("integer cents");
    const sid = /\*\*Session:\*\*\s*([0-9a-f-]{36})/i.exec(text)?.[1];
    expect(sid).toBeTruthy();
    const digest = join(root, ".story", "sessions", sid!, "context-digest.md");
    expect(existsSync(digest)).toBe(true);
    const d = readFileSync(digest, "utf-8");
    expect(d).not.toContain(MAP.rulings.R3);
    expect(d).not.toContain("integer cents");
  });
});


/** Starts a plan-mode session on T-2 through the real guide; returns the session id, its dir, and the PLAN text. */
async function startPlan(root: string): Promise<{ sid: string; dir: string; text: string }> {
  const result = await handleAutonomousGuide(root, { sessionId: null, action: "start", mode: "plan", ticketId: "T-2" } as never);
  const text = (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
  const sid = /\*\*Session:\*\*\s*([0-9a-f-]{36})/i.exec(text)?.[1];
  expect(sid, text).toBeTruthy();
  return { sid: sid!, dir: join(root, ".story", "sessions", sid!), text };
}

async function report(root: string, sid: string, rep: Record<string, unknown>): Promise<string> {
  const result = await handleAutonomousGuide(root, { sessionId: sid, action: "report", report: rep } as never);
  return (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
}

const EXISTING_OK = "EXISTING: src/platform/logging/AppLogger.ts ; extend ; AppLogger already carries request ids and redaction";

describe("continuity cases 1, 2, 6, 7, 7n and 14: the context brief (T-526)", () => {
  it("1 delivery tiers: the guide's PLAN entry writes a brief with no binding, R2 and R1 suggested, R3 absent", async () => {
    const root = copy(1, "T-2.a", true);
    const { dir, text } = await startPlan(root);
    expect(text).toContain("## Context brief");
    expect(text).toContain("context-brief.md");
    const brief = readFileSync(join(dir, "context-brief.md"), "utf-8");
    expect(brief).toContain("none: this item cites no rulings");
    const suggested = brief.slice(brief.indexOf("## Suggested accepted rulings"), brief.indexOf("## Disclosure"));
    expect(suggested.indexOf(`**${MAP.rulings.R2}**`)).toBeGreaterThan(-1);
    expect(suggested.indexOf(`**${MAP.rulings.R1}**`)).toBeGreaterThan(suggested.indexOf(`**${MAP.rulings.R2}**`));
    expect(suggested).toContain("tag:jobs (path src/jobs/)");
    expect(brief).not.toContain(MAP.rulings.R3);
    expect(brief).toContain("no capability inventory");
  });

  it("2 discovery then citation: suggested R2, cited on the item, then binding in the packet and enforced by the guard", async () => {
    const root = copy(1, "T-2.a", true);
    const before = await buildContextBrief(root, "T-2");
    expect(before.suggested.map((x) => x.id)).toContain(MAP.rulings.R2);
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [MAP.rulings.R2] }, null, 2));
    const after = await buildContextBrief(root, "T-2");
    expect(after.suggested.map((x) => x.id)).not.toContain(MAP.rulings.R2);
    expect(after.binding).toHaveLength(1);
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind === "resolved" && res.citations.map((c) => c.citedId)).toEqual([MAP.rulings.R2]);
    expect((await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nNo ids here.")).ok).toBe(false);
    expect((await guardPlanNamesCitedRulings(root, "T-2", `# Plan\n\nFollows ${MAP.rulings.R2}.`)).ok).toBe(true);
    // Through the guide: the plan reviewer sees R2 as binding, never among the suggestions.
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qam", "cite R2"], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
    const { sid, dir } = await startPlan(root);
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${EXISTING_OK}\n\n1. Add logging per ${MAP.rulings.R2}.\n`);
    const review = await report(root, sid, { completedAction: "plan_written" });
    const suggestedAt = review.indexOf("# Suggested (not binding)");
    expect(suggestedAt).toBeGreaterThan(-1);
    expect(review.slice(0, suggestedAt)).toContain(MAP.rulings.R2);
    expect(review.slice(suggestedAt, review.indexOf("# Plan checks"))).not.toContain(MAP.rulings.R2);
  });

  it("6 no-path variant (b): cap-logging by title word, with the no-paths-named disclosure", async () => {
    const root = copy(3, "T-2.b", true);
    const { dir } = await startPlan(root);
    const brief = readFileSync(join(dir, "context-brief.md"), "utf-8");
    expect(brief).toContain("(cap-logging)");
    expect(brief).toContain("matched by title:logging");
    expect(brief).toContain(NO_PATHS_NAMED);
  });

  it("7 EXISTING gate: a plan without the EXISTING line is retried; with it the plan reaches review", async () => {
    const root = copy(1, "T-2.a", true);
    const { sid, dir } = await startPlan(root);
    writeFileSync(join(dir, "plan.md"), "# Plan\n\n1. Add logging to src/jobs/JobQueue.ts.\n");
    const retried = await report(root, sid, { completedAction: "plan_written" });
    expect(retried).toContain("Plan not accepted: the plan has no EXISTING line.");
    writeFileSync(join(dir, "plan.md"), "# Plan\n\nEXISTING: none\n\n1. Add logging.\n");
    expect(await report(root, sid, { completedAction: "plan_written" })).toContain("says none without naming what was inspected");
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${EXISTING_OK}\n\n1. Add logging to src/jobs/JobQueue.ts through AppLogger.\n`);
    expect(await report(root, sid, { completedAction: "plan_written" })).toMatch(/Plan Review -- Round 1/);
  });

  it("7n EXISTING negative: the plan reviewer is told a grep transcript is a finding, and sees the suggestions and the manifest", async () => {
    const root = copy(1, "T-2.a", true);
    const { sid, dir } = await startPlan(root);
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${EXISTING_OK}\n\n1. Add logging.\n`);
    const review = await report(root, sid, { completedAction: "plan_written" });
    expect(review).toContain(PLAN_REVIEWER_CHECKS[0]);
    expect(review).toContain(PLAN_REVIEWER_CHECKS[1]);
    expect(review).toContain("# Suggested (not binding)");
    expect(review).toContain(`- ${MAP.rulings.R2} (suggested by`);
    expect(review).toContain("contextManifest: context-manifests/T-2-1");
    const suggestedBlock = review.slice(review.indexOf("# Suggested (not binding)"), review.indexOf("# Plan checks"));
    expect(suggestedBlock).not.toMatch(/\bcited\b/i);
  });

  it("14 change detection: replan, resume and CODE_REVIEW entry each detect a governing change on their own", async () => {
    const obligation = `governing context changed: ${MAP.rulings.R2} withdrawn`;
    const recipe = resolveRecipe("coding", {});
    const outstandingOf = (state: unknown): string[] =>
      ((state as { contextManifests?: Record<string, { outstanding: { id: string; kind: string }[] }> }).contextManifests?.["T-2"]?.outstanding ?? []).map((o) => `${o.id}:${o.kind}`);
    /** A fresh plan session whose manifest predates R2's withdrawal: nothing is outstanding yet. */
    const withdrawnAfterPublish = async (): Promise<{ root: string; sid: string; dir: string }> => {
      const root = copy(1, "T-2.a", true);
      const { sid, dir } = await startPlan(root);
      const rulingFile = join(root, ".story", "rulings", `${MAP.rulings.R2}.json`);
      writeFileSync(rulingFile, JSON.stringify({ ...JSON.parse(readFileSync(rulingFile, "utf-8")), status: "withdrawn" }, null, 2));
      expect(outstandingOf(readSession(dir))).toEqual([]);
      return { root, sid, dir };
    };

    // Replan: PLAN's own entry detects it, opens with the obligation, and the guard enforces it.
    {
      const { root, sid, dir } = await withdrawnAfterPublish();
      const planCtx = new StageContext(root, dir, readSession(dir)!, recipe);
      const replan = await new PlanStage().enter(planCtx);
      expect("instruction" in replan && replan.instruction).toContain(obligation);
      expect(outstandingOf(readSession(dir))).toEqual([`${MAP.rulings.R2}:withdrawn`]);
      writeFileSync(join(dir, "plan.md"), `# Plan\n\n${EXISTING_OK}\n\n1. Add logging.\n`);
      expect(await report(root, sid, { completedAction: "plan_written" })).toContain(`governing context changed and the plan does not address ${MAP.rulings.R2}`);
    }

    // CODE_REVIEW entry: its own first-round diff finds the change and sends the item back to PLAN.
    {
      const { root, dir } = await withdrawnAfterPublish();
      const crCtx = new StageContext(root, dir, { ...readSession(dir)!, state: "CODE_REVIEW" } as never, recipe);
      const cr = await new CodeReviewStage().enter(crCtx);
      expect(cr).toMatchObject({ action: "back", target: "PLAN", reason: "governing_context_changed" });
      expect(outstandingOf(crCtx.state)).toEqual([`${MAP.rulings.R2}:withdrawn`]);
    }

    // Resume at PLAN_REVIEW: the gate runs before the stage is entered and persists what it found.
    {
      const { root, sid, dir } = await withdrawnAfterPublish();
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
      const live = readSession(dir)!;
      prepareForCompact(dir, writeSessionSync(dir, { ...live, state: "PLAN_REVIEW", git: { ...live.git, expectedHead: head } } as never), { expectedHead: head });
      const resumed = await handleAutonomousGuide(root, { sessionId: sid, action: "resume" } as never);
      const text = (resumed as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
      expect(text).toContain(`> ${obligation}`);
      expect(outstandingOf(readSession(dir))).toEqual([`${MAP.rulings.R2}:withdrawn`]);
    }
  });

  it("14u unreadable pointer map: CODE_REVIEW holds at entry on every round and refuses a verdict; it is never read as no obligations", async () => {
    const root = copy(1, "T-2.a", true);
    const { dir } = await startPlan(root);
    const recipe = resolveRecipe("coding", {});
    const damaged = { ...readSession(dir)!, state: "CODE_REVIEW", contextManifests: { "T-2": { current: 7 } } } as never;
    const hold = "Holding: this item's governing context cannot be verified (state.contextManifests is malformed";
    const first = await new CodeReviewStage().enter(new StageContext(root, dir, damaged, recipe));
    expect("instruction" in first && first.instruction).toContain(hold);
    expect(first).not.toHaveProperty("action");
    const later = { ...(damaged as object), reviews: { plan: [], code: [{ round: 1, reviewer: "agent", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 1, suggestionCount: 0, timestamp: new Date().toISOString() }] } } as never;
    const second = await new CodeReviewStage().enter(new StageContext(root, dir, later, recipe));
    expect("instruction" in second && second.instruction).toContain(hold);
    const verdict = await new CodeReviewStage().report(new StageContext(root, dir, damaged, recipe), { completedAction: "code_review_round", verdict: "approve", findings: [] } as never);
    expect(verdict).toMatchObject({ action: "retry" });
    expect((verdict as { instruction: string }).instruction).toContain(hold);
  });

  it("14t a governing check that throws is not a clear one: CODE_REVIEW holds at entry and refuses the first verdict", async () => {
    const root = copy(1, "T-2.a", true);
    const { dir } = await startPlan(root);
    const recipe = resolveRecipe("coding", {});
    // The item vanishing from the ledger makes the brief, and so the check, throw.
    rmSync(join(root, ".story", "tickets", "T-2.json"));
    const state = { ...readSession(dir)!, state: "CODE_REVIEW" } as never;
    const entered = await new CodeReviewStage().enter(new StageContext(root, dir, state, recipe));
    expect("instruction" in entered && entered.instruction).toContain("Holding: this item's governing context cannot be verified (governing context could not be checked");
    const verdict = await new CodeReviewStage().report(new StageContext(root, dir, state, recipe), { completedAction: "code_review_round", verdict: "approve", findings: [] } as never);
    expect(verdict).toMatchObject({ action: "retry" });
    expect((verdict as { instruction: string }).instruction).toContain("governing context could not be checked");
  });

  it("14r once a failed check is repaired, a verdict on a plan that a governing change overtook goes back to PLAN", async () => {
    const root = copy(1, "T-2.a", true);
    const { dir } = await startPlan(root);
    const recipe = resolveRecipe("coding", {});
    const ticket = join(root, ".story", "tickets", "T-2.json");
    const ticketBytes = readFileSync(ticket, "utf-8");
    const rulingFile = join(root, ".story", "rulings", `${MAP.rulings.R2}.json`);
    writeFileSync(rulingFile, JSON.stringify({ ...JSON.parse(readFileSync(rulingFile, "utf-8")), status: "withdrawn" }, null, 2));
    rmSync(ticket);
    const state = { ...readSession(dir)!, state: "CODE_REVIEW" } as never;
    const entered = await new CodeReviewStage().enter(new StageContext(root, dir, state, recipe));
    expect("instruction" in entered && entered.instruction).toContain("Holding:");
    writeFileSync(ticket, ticketBytes);
    const verdict = await new CodeReviewStage().report(new StageContext(root, dir, state, recipe), { completedAction: "code_review_round", verdict: "approve", findings: [] } as never);
    expect(verdict).toMatchObject({ action: "back", target: "PLAN", reason: "governing_context_changed" });
  });

  it("P-1 pick entry: an auto-mode pick of T-2 is a PLAN entry and delivers the brief", async () => {
    const root = copy(1, "T-2.a", true);
    const { dir } = await startPlan(root);
    const live = readSession(dir)!;
    const ctx = new StageContext(root, dir, { ...live, state: "PICK_TICKET", mode: "auto", ticket: undefined } as never, resolveRecipe("coding", {}));
    const picked = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-2" });
    expect(picked.action).toBe("advance");
    const instruction = (picked as { result?: { instruction?: string } }).result?.instruction ?? "";
    expect(instruction).toContain("## Context brief");
    expect(readFileSync(join(dir, "context-brief.md"), "utf-8")).toContain(`**${MAP.rulings.R2}**`);
    expect(existsSync(join(dir, "context-manifests", "T-2-2.json"))).toBe(true);
  });

  it("P-1 drift entry: HEAD moving while COMPACT was pending re-enters PLAN with a fresh brief", async () => {
    const root = copy(1, "T-2.a", true);
    const { sid, dir } = await startPlan(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    // A parentless sibling of HEAD: never an ancestor, so the resume reads it as external drift.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" };
    const sibling = execFileSync("git", ["commit-tree", `${head}^{tree}`, "-m", "sibling"], { cwd: root, env, encoding: "utf-8" }).trim();
    prepareForCompact(dir, readSession(dir)!, { expectedHead: sibling });
    const resumed = await handleAutonomousGuide(root, { sessionId: sid, action: "resume" } as never);
    const text = (resumed as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
    expect(text).toContain("HEAD changed while COMPACT was pending");
    expect(text).toContain("## Context brief");
    expect(existsSync(join(dir, "context-manifests", "T-2-2.json"))).toBe(true);
  });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" }).trim();
}
function commitAll(root: string, message: string): string {
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return gitIn(root, ["rev-parse", "HEAD"]);
}

/**
 * T-3 implemented and committed through the guide: the move of
 * src/platform/logging/ to packages/logging/ with its imports, the ticket
 * complete, then FINALIZE's commit_done. Returns the KNOWLEDGE_REVIEW text.
 */
async function commitT3(root: string): Promise<{ sid: string; dir: string; impl: string; text: string }> {
  const base = gitIn(root, ["rev-parse", "HEAD"]);
  mkdirSync(join(root, "packages"), { recursive: true });
  gitIn(root, ["mv", "src/platform/logging", "packages/logging"]);
  for (const f of ["src/http/handler.ts", "src/http/router.ts", "src/http/router.test.ts"]) {
    const path = join(root, f);
    writeFileSync(path, readFileSync(path, "utf-8").replaceAll("../platform/logging/", "../../packages/logging/"));
  }
  const ticket = join(root, ".story", "tickets", "T-3.json");
  writeFileSync(ticket, JSON.stringify({ ...JSON.parse(readFileSync(ticket, "utf-8")), status: "complete", completedDate: "2026-09-22" }, null, 2));
  const impl = commitAll(root, "T-3: move AppLogger into packages/logging");

  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = sessionDir(root, session.sessionId);
  mkdirSync(dir, { recursive: true });
  writeSessionSync(dir, {
    ...session,
    state: "FINALIZE",
    finalizeCheckpoint: "precommit_passed",
    ticket: { id: "T-3", title: "Move AppLogger into packages/logging", risk: "low" },
    claimEpoch: null,
    itemAttempt: { id: "att-T-3", workItemId: "T-3", kind: "ticket", startedAt: new Date().toISOString(), generation: 1 },
    config: { ...session.config, maxTicketsPerSession: 1 },
    git: { ...session.git, branch: "main", mergeBase: base, expectedHead: base, initHead: base, itemBaseHead: base },
  } as FullSessionState);
  // No claim epoch in this fixture, so attribution is overridden as the ISS-063 tests do.
  const text = await report(root, session.sessionId, { completedAction: "commit_done", commitHash: impl, overrideAttribution: true });
  return { sid: session.sessionId, dir, impl, text };
}

function handoverAdded(root: string, before: readonly string[]): string {
  const added = readdirSync(join(root, ".story", "handovers")).filter((f) => !before.includes(f));
  expect(added).toHaveLength(1);
  return readFileSync(join(root, ".story", "handovers", added[0]!), "utf-8");
}

/** Case 9: arm 3 as filed, then the capability file removed before the temp repository is committed. The glossary stays. */
function removeCapabilities(dest: string): void {
  rmSync(join(dest, ".story", "capabilities.json"));
}

describe("continuity case 9: arm 2 subset, the capability file removed (T-526)", () => {
  const { R1, R2, R3, R4, R5 } = MAP.rulings as Record<"R1" | "R2" | "R3" | "R4" | "R5", string>;

  it("9 control: arm 3 as filed delivers cap-logging and no missing-inventory disclosure, so the removal is what changes the brief", async () => {
    const { dir } = await startPlan(copy(3, "T-2.a", true));
    const brief = readFileSync(join(dir, "context-brief.md"), "utf-8");
    expect(brief).toContain("(cap-logging)");
    expect(brief).not.toContain("no capability inventory");
  });

  it("9 cases 1, 5 and 7: the guide's brief has no binding, R2 then R1 suggested, R3 absent, the disclosure says no capability inventory, and the EXISTING gate holds", async () => {
    const root = copy(3, "T-2.a", true, removeCapabilities);
    expect(existsSync(join(root, ".story", "capabilities.json"))).toBe(false);
    expect(existsSync(join(root, ".story", "glossary.json"))).toBe(true);
    const { sid, dir, text } = await startPlan(root);
    expect(text).toContain("## Context brief");
    expect(text).not.toContain(R3);
    const brief = readFileSync(join(dir, "context-brief.md"), "utf-8");
    expect(brief).toContain("none: this item cites no rulings");
    const suggested = brief.slice(brief.indexOf("## Suggested accepted rulings"), brief.indexOf("## Disclosure"));
    expect(suggested.indexOf(`**${R2}**`)).toBeGreaterThan(-1);
    expect(suggested.indexOf(`**${R1}**`)).toBeGreaterThan(suggested.indexOf(`**${R2}**`));
    expect(brief).not.toContain(R3);
    const disclosure = brief.slice(brief.indexOf("## Disclosure"));
    expect(disclosure).toContain("no capability inventory");
    expect(disclosure).not.toContain("capabilities unavailable");
    expect(disclosure).not.toContain("no glossary");
    expect(brief).not.toContain("(cap-logging)");
    const digest = readFileSync(join(dir, "context-digest.md"), "utf-8");
    expect(digest).not.toContain(R3);
    writeFileSync(join(dir, "plan.md"), "# Plan\n\n1. Add logging to src/jobs/JobQueue.ts.\n");
    expect(await report(root, sid, { completedAction: "plan_written" })).toContain("Plan not accepted: the plan has no EXISTING line.");
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${EXISTING_OK}\n\n1. Add logging to src/jobs/JobQueue.ts through AppLogger.\n`);
    expect(await report(root, sid, { completedAction: "plan_written" })).toMatch(/Plan Review -- Round 1/);
  });

  it("9 case 2: suggested R2, cited on the item, then binding in the packet, enforced by the guard, and binding at the plan reviewer", async () => {
    const root = copy(3, "T-2.a", true, removeCapabilities);
    expect((await buildContextBrief(root, "T-2")).suggested.map((x) => x.id)).toContain(R2);
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [R2] }, null, 2));
    const after = await buildContextBrief(root, "T-2");
    expect(after.suggested.map((x) => x.id)).not.toContain(R2);
    expect(after.binding).toHaveLength(1);
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind === "resolved" && res.citations.map((c) => c.citedId)).toEqual([R2]);
    expect((await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nNo ids here.")).ok).toBe(false);
    expect((await guardPlanNamesCitedRulings(root, "T-2", `# Plan\n\nFollows ${R2}.`)).ok).toBe(true);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qam", "cite R2"], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
    const { sid, dir } = await startPlan(root);
    expect(readFileSync(join(dir, "context-brief.md"), "utf-8")).toContain("no capability inventory");
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${EXISTING_OK}\n\n1. Add logging per ${R2}.\n`);
    const review = await report(root, sid, { completedAction: "plan_written" });
    const suggestedAt = review.indexOf("# Suggested (not binding)");
    expect(suggestedAt).toBeGreaterThan(-1);
    expect(review.slice(0, suggestedAt)).toContain(R2);
    expect(review.slice(suggestedAt, review.indexOf("# Plan checks"))).not.toContain(R2);
  });

  it("9 case 3: the proposal R4 reaches the item beside its citations, the guard does not enforce it, R1 stays current", async () => {
    const root = withLifecycle(copy(3, "T-2.a", false, removeCapabilities));
    const { rulings, lifecycleById, unavailableIds } = loadRulingsSafe(root);
    expect(lifecycleById.get(R4)).toBe("proposed");
    expect(buildSuccessorIndex(rulings).successorsByTarget.get(R1)).toBeUndefined();
    const ctx = buildCitationResolutionContext(rulings, unavailableIds, "complete", false);
    expect(resolveCitation(R1, ctx)).toMatchObject({ status: "resolved", stale: false, current: { id: R1 } });
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.proposals.map((p) => p.id)).toEqual([R4]);
    expect(res.citations.map((c) => c.citedId)).not.toContain(R4);
    expect(await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nNothing about rulings.")).toEqual({ ok: true, note: `Proposals against this item (not enforced): ${R4}` });
  });

  it("9 case 4: a citation of the superseded R5 resolves forward to R1 with R1's wording through the packet path", async () => {
    const root = copy(3, "T-2.a", false, removeCapabilities);
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [R5] }, null, 2));
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    const c = res.citations[0]!;
    expect(res.citations).toHaveLength(1);
    expect(c).toMatchObject({ status: "resolved", citedId: R5, stale: true, current: { id: R1 }, chain: [R5, R1] });
    if (c.status !== "resolved") return;
    expect(c.current.text).toContain("Logging keeps redaction and request ids on every path");
  });
});

describe("continuity cases 8 and 15: knowledge review at completion (T-527)", () => {
  it("8 completion: the T-3 move owes cap-logging a review; a report without knowledgeImpact is retried; the maintained stale-reference advances and lands in the handover", async () => {
    const root = copy(3, "T-3", true);
    const handoversBefore = readdirSync(join(root, ".story", "handovers"));
    const { sid, dir, impl, text } = await commitT3(root);
    expect(text).toContain("# Knowledge review: T-3");
    expect(text).toMatch(/Stale capability entries[^\n]*\n- cap-logging:/);
    expect(readSession(dir)?.state).toBe("KNOWLEDGE_REVIEW");

    expect(await report(root, sid, { completedAction: "knowledge_reviewed" })).toContain("knowledgeImpact is missing or invalid");
    expect(readSession(dir)?.state).toBe("KNOWLEDGE_REVIEW");

    // The maintenance, in its own ledger-only commit: cap-logging follows the move.
    const capsFile = join(root, ".story", "capabilities.json");
    const caps = JSON.parse(readFileSync(capsFile, "utf-8")) as { capabilities: Record<string, unknown>[] };
    caps.capabilities = caps.capabilities.map((c) => c.id !== "cap-logging" ? c : {
      ...c,
      surfaces: { files: ["packages/logging/AppLogger.ts"] },
      entryPoints: ["packages/logging/"],
      contract: String(c.contract).replace("src/platform/logging/AppLogger.ts", "packages/logging/AppLogger.ts"),
      checkedAt: { sha: impl, date: "2026-09-22" },
    });
    writeFileSync(capsFile, JSON.stringify(caps, null, 2) + "\n");
    const m1 = commitAll(root, "ledger: cap-logging follows the move");

    const accepted = await report(root, sid, {
      completedAction: "knowledge_reviewed",
      knowledgeImpact: {
        implementationCommit: impl,
        maintenanceCommits: [m1],
        checked: ["cap-logging"],
        outcome: "impacts",
        impacts: [{ record: "cap-logging", kind: "stale-reference", proposed: "entry points follow the move", disposition: "applied", evidence: { record: "cap-logging" } }],
      },
    });
    expect(accepted).toContain("Knowledge review accepted for **T-3**: 1 impact: 1 applied.");
    expect(readSession(dir)?.state).toBe("HANDOVER");

    await report(root, sid, { completedAction: "handover_written", handoverContent: "# Session\n\nMoved AppLogger.\n" });
    const handover = handoverAdded(root, handoversBefore);
    expect(handover).toContain("## Knowledge impact");
    expect(handover).toContain(`### T-3 (ticket, committed at ${impl.slice(0, 12)})`);
    expect(handover).toContain("  - cap-logging (stale-reference): applied. entry points follow the move");
    expect(handover).toContain(`- Maintenance commits: ${m1.slice(0, 12)}`);
  });

  it("15 second-handoff maintenance: a disposition per impact, and the follow-up is durable in a second session", async () => {
    const root = copy(3, "T-3", true);
    const handoversBefore = readdirSync(join(root, ".story", "handovers"));
    const { sid, impl } = await commitT3(root);

    // Neither record is fixed now: cap-logging is marked, N-1 gets a follow-up issue.
    const note = "cap-logging entry points still name the old logging directory, moved by T-3";
    await handleCapabilityDefer({ id: "cap-logging", note }, "json", root);
    // The fixture has no issues yet, so git kept no .story/issues/ (ISS-1297).
    mkdirSync(join(root, ".story", "issues"), { recursive: true });
    const created = await handleIssueCreate(
      { title: "N-1 names the old AppLogger path", severity: "low", impact: "N-1 still says AppLogger lives in src/platform/logging/; T-3 moved it to packages/logging/.", components: [], relatedTickets: [], location: [] },
      "json",
      root,
    );
    const issue = (JSON.parse(created.output ?? "{}") as { data: { id: string; displayId?: string } }).data;
    const m1 = commitAll(root, "ledger: mark cap-logging, file the N-1 follow-up");

    const accepted = await report(root, sid, {
      completedAction: "knowledge_reviewed",
      knowledgeImpact: {
        implementationCommit: impl,
        maintenanceCommits: [m1],
        checked: ["cap-logging", "N-1"],
        outcome: "impacts",
        impacts: [
          { record: "cap-logging", kind: "stale-reference", proposed: "entry points follow the move", disposition: "pending", evidence: { record: "cap-logging" } },
          { record: "N-1", kind: "stale-reference", proposed: "the note names the new path", disposition: "pending", evidence: { record: "N-1", issueId: issue.id } },
        ],
      },
    });
    expect(accepted).toContain("Knowledge review accepted for **T-3**: 2 impacts: 2 pending.");

    await report(root, sid, { completedAction: "handover_written", handoverContent: "# Session\n\nMoved AppLogger; follow-ups filed.\n" });
    const handover = handoverAdded(root, handoversBefore);
    expect(handover).toContain("  - cap-logging (stale-reference): pending. entry points follow the move");
    expect(handover).toContain(`  - N-1 (stale-reference): pending, follow-up ${issue.id}. the note names the new path`);

    // A second session: the marker reaches the next brief that matches cap-logging, and the issue is still open.
    commitAll(root, "session 1 handover");
    const { dir: dir2 } = await startPlan(root);
    const brief = readFileSync(join(dir2, "context-brief.md"), "utf-8");
    expect(brief).toContain("(cap-logging)");
    expect(brief).toContain(`review: ${note}`);
    const { state } = await loadProject(root);
    expect(state.issues.find((i) => i.id === issue.id)?.status).toBe("open");
  });
});

describe("continuity cases 3 and 10 to 13: ruling lifecycle (T-522)", () => {
  const R1 = MAP.rulings.R1;
  const R4 = MAP.rulings.R4;

  it("3 proposed not binding: R4 renders under Proposed, the guard ignores it, R1 stays current, no successor index entry for R1", async () => {
    const root = withLifecycle(copy(1));
    const { rulings, lifecycleById, unavailableIds } = loadRulingsSafe(root);
    expect(lifecycleById.get(R4)).toBe("proposed");
    expect(lifecycleById.get(R1)).toBe("accepted-legacy");
    expect(unavailableIds.size).toBe(0);
    const index = buildSuccessorIndex(rulings);
    expect(index.successorsByTarget.get(R1)).toBeUndefined();
    expect(index.uncertainSuccessorsByTarget.get(R1)).toBeUndefined();
    const ctx = buildCitationResolutionContext(rulings, unavailableIds, "complete", false);
    expect(resolveCitation(R1, ctx)).toMatchObject({ status: "resolved", stale: false, current: { id: R1 } });
    // Delivery: the proposal reaches the item beside its citations, never among them.
    const res = await citationsForReviewTarget(root, "T-2");
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.proposals.map((p) => p.id)).toEqual([R4]);
    expect(res.citations.map((c) => c.citedId)).not.toContain(R4);
    // The guard does not demand the plan name R4; it names it as not enforced.
    const verdict = await guardPlanNamesCitedRulings(root, "T-2", "# Plan\n\nNothing about rulings.");
    expect(verdict).toEqual({ ok: true, note: `Proposals against this item (not enforced): ${R4}` });
    // The Decisions listing files R4 under Proposed, R1 under Accepted.
    const md = handleRulingList({}, await ctxFor(root)).output;
    const proposedAt = md.indexOf("## Proposed (not binding)");
    expect(proposedAt).toBeGreaterThan(md.indexOf("## Accepted"));
    expect(md.indexOf(`### ${R4} [proposed]`)).toBeGreaterThan(proposedAt);
    expect(md).toContain(`Proposals against this ruling (not binding): ${R4}`);
  });

  it("10x export half of case 10: the Decisions section renders R4 under Proposed in both scopes; a phase export follows T-2's citation of R5 forward to R1", async () => {
    const root = withLifecycle(copy(1));
    const all = handleExport(await ctxFor(root), "all", null).output;
    const decisionsAt = all.indexOf("## Decisions (");
    expect(decisionsAt).toBeGreaterThan(-1);
    const proposedAt = all.indexOf("## Proposed (not binding)", decisionsAt);
    expect(proposedAt).toBeGreaterThan(all.indexOf("## Accepted", decisionsAt));
    expect(all.indexOf(`### ${R4} [proposed]`)).toBeGreaterThan(proposedAt);
    // A proposal for nobody: in the all export, absent from p1 (proposal filtering is per phase item).
    const q = JSON.parse((await handleRulingPropose({ text: "Q for nobody", attribution: "owner-direct", date: "2026-09-22", scopeTags: [], clientTaskId: CALLER }, "json", root)).output).data.id as string;
    expect(handleExport(await ctxFor(root), "all", null).output).toContain(`### ${q} [proposed]`);
    // Phase p1 holds T-1 (cites R1) and T-2 (R4 is proposed for it, cites nothing): R4 and R1 export, R5 and Q do not.
    const phase = handleExport(await ctxFor(root), "phase", "p1").output;
    const phaseProposedAt = phase.indexOf("## Proposed (not binding)");
    expect(phaseProposedAt).toBeGreaterThan(phase.indexOf("## Decisions ("));
    expect(phase.indexOf(`### ${R4} [proposed]`)).toBeGreaterThan(phaseProposedAt);
    expect(phase).toContain(`### ${R1} [accepted-legacy]`);
    expect(phase).not.toContain(`### ${MAP.rulings.R5}`);
    expect(phase).not.toContain(q);
    // T-1 stops citing R1, R4 stops proposing against it, and T-2 cites the superseded R5: R1 can now only arrive by forward traversal from R5, and each appears once.
    const r4Path = join(root, ".story", "rulings", `${R4}.json`);
    writeFileSync(r4Path, JSON.stringify({ ...JSON.parse(readFileSync(r4Path, "utf-8")), proposesToSupersede: null }, null, 2));
    const t1 = join(root, ".story", "tickets", "T-1.json");
    writeFileSync(t1, JSON.stringify({ ...JSON.parse(readFileSync(t1, "utf-8")), citesRulings: [] }, null, 2));
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [MAP.rulings.R5] }, null, 2));
    const cited = handleExport(await ctxFor(root), "phase", "p1").output;
    expect(cited.split(`### ${MAP.rulings.R5} [superseded]`).length).toBe(2);
    expect(cited.split(`### ${R1} [accepted-legacy]`).length).toBe(2);
    expect(cited.split(`### ${R1} `).length).toBe(2);
    expect(cited).toContain(`### ${R4} [proposed]`);
    expect(cited).not.toContain(q);
  });

  it("10 lifecycle isolation matrix, per operation per reader: get, incoming citation, list JSON, create-against, old reader", async () => {
    const root = withLifecycle(copy(1));
    const jsonCtx = { ...(await ctxFor(root)), format: "json" as const };
    // (a) get: an explicit proposal result, never a chain.
    const got = JSON.parse(handleRulingGet(R4, jsonCtx).output).data;
    expect(got.lifecycle).toBe("proposed");
    expect(got.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(got.chainStatus.status).toBe("nonaccepted");
    // (b) an item hand-cites R4: validate errors, the guard fails closed, the citation never converts R4.
    const t = join(root, ".story", "tickets", "T-2.json");
    writeFileSync(t, JSON.stringify({ ...JSON.parse(readFileSync(t, "utf-8")), citesRulings: [R4] }, null, 2));
    const out = handleValidate(await ctxFor(root)).output;
    expect(out).toContain("ruling_citation_of_nonaccepted");
    const refused = await guardPlanNamesCitedRulings(root, "T-2", `# Plan\n\nPer ${R4}.`);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.instruction).toContain("proposed");
    const cited = await citationsForReviewTarget(root, "T-2");
    expect(cited.kind === "resolved" && cited.citations[0]!.status).toBe("nonaccepted");
    expect(loadRulingsSafe(root).lifecycleById.get(R4)).toBe("proposed");
    // (c) list JSON carries lifecycle on every record.
    const listed = JSON.parse(handleRulingList({}, jsonCtx).output).data as { id: string; lifecycle: string }[];
    expect(listed.find((r) => r.id === R4)!.lifecycle).toBe("proposed");
    expect(listed.find((r) => r.id === R1)!.lifecycle).toBe("accepted-legacy");
    expect(listed.every((r) => typeof r.lifecycle === "string")).toBe(true);
    // (d) a second proposal against R1 changes nothing about R1.
    const q = JSON.parse((await handleRulingPropose({ text: "Q", attribution: "owner-direct", date: "2026-09-22", scopeTags: [], proposesToSupersede: R1, clientTaskId: CALLER }, "json", root)).output).data;
    const after = loadRulingsSafe(root);
    expect(buildSuccessorIndex(after.rulings).successorsByTarget.get(R1)).toBeUndefined();
    expect(after.unavailableIds.size).toBe(0);
    expect(resolveCitation(R1, buildCitationResolutionContext(after.rulings, after.unavailableIds, "complete", false)).status).toBe("resolved");
    expect(JSON.parse(handleRulingGet(R1, { ...jsonCtx }).output).data.proposalsAgainst.sort()).toEqual([R4, q.id].sort());
    // (e) the OLD reader (1.15 code pinned at 655b03bf) over the same ledger: every record parses, R1 unsuperseded,
    // R4 shown as an ordinary current ruling. The documented boundary, not a promise.
    const oldRulings = after.rulings.map((r) => OldRulingSchema.parse(JSON.parse(JSON.stringify(r))));
    const oldIndex = oracle.buildSuccessorIndex(oldRulings);
    expect(oldIndex.successorsByTarget.get(R1)).toBeUndefined();
    const oldCtx = oracle.buildCitationResolutionContext(oldRulings, new Set(), "complete", false);
    expect(oracle.resolveCitation(R1, oldCtx)).toMatchObject({ status: "resolved", stale: false });
    expect(oracle.resolveCitation(R4, oldCtx)).toMatchObject({ status: "resolved", stale: false, current: { id: R4 } });
  });

  it("11 revision-bound acceptance: accept refused when the proposal changed since review; accepted at the current revision; retry is a no-op", async () => {
    const root = withLifecycle(copy(1));
    const file = join(root, ".story", "rulings", `${R4}.json`);
    const reviewed = payloadDigest(RulingSchema.parse(JSON.parse(readFileSync(file, "utf-8"))));
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), text: "Background work carries the request id of the job that enqueued it, always" }, null, 2));
    const args = { revision: reviewed, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER };
    await expect(handleRulingAccept(R4, args, "json", root)).rejects.toThrow(/changed since it was reviewed/);
    expect(loadRulingsSafe(root).lifecycleById.get(R4)).toBe("proposed");
    const current = payloadDigest(RulingSchema.parse(JSON.parse(readFileSync(file, "utf-8"))));
    const accepted = JSON.parse((await handleRulingAccept(R4, { ...args, revision: current }, "json", root)).output).data;
    expect(accepted.noop).toBe(false);
    expect(accepted.supersedes).toBe(R1);
    const t2 = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-2.json"), "utf-8"));
    expect(t2.citesRulings).toContain(R4);
    const again = JSON.parse((await handleRulingAccept(R4, { ...args, revision: current }, "json", root)).output).data;
    expect(again.noop).toBe(true);
    const { rulings, unavailableIds } = loadRulingsSafe(root);
    expect(resolveCitation(R1, buildCitationResolutionContext(rulings, unavailableIds, "complete", false))).toMatchObject({ status: "resolved", stale: true, current: { id: R4 } });
  });

  it("12 interrupted-accept recovery: covered where the commit-phase failure can be injected, test/core/ruling-transaction-recovery.test.ts (T-522 case 12)", () => {
    const src = readFileSync(resolve(__dirname, "../core/ruling-transaction-recovery.test.ts"), "utf-8");
    expect(src).toContain("continuity case 12");
  });

  it("13 merge integrity: acceptance does not survive onto an edited revision; the merged record binds nothing until resolved", async () => {
    const root = withLifecycle(copy(1));
    const base = JSON.parse(readFileSync(join(root, ".story", "rulings", `${R4}.json`), "utf-8")) as Record<string, unknown>;
    const reviewed = payloadDigest(RulingSchema.parse(base));
    await handleRulingAccept(R4, { revision: reviewed, attribution: "owner-direct", date: "2026-09-22", clientTaskId: CALLER }, "json", root);
    const sideA = JSON.parse(readFileSync(join(root, ".story", "rulings", `${R4}.json`), "utf-8")) as Record<string, unknown>;
    const sideB = { ...base, text: "Background work carries the request id of the job that enqueued it, always" };
    for (const [ours, theirs] of [[sideA, sideB], [sideB, sideA]] as const) {
      const merged = threeWayMerge(base, ours, theirs, "ruling").merged;
      const parsed = RulingSchema.parse(merged);
      expect(classifyLifecycle(parsed).lifecycle).toBe("conflicted");
      const editedWithAcceptance = parsed.text === sideB.text && parsed.acceptance !== undefined;
      expect(editedWithAcceptance).toBe(false);
      if (parsed.acceptance) expect(parsed.acceptance.payloadDigest).toBe(payloadDigest(parsed));
      // Written back, the merged record binds nothing: R1's chain is indeterminate and a citation of R4 is refused.
      writeFileSync(join(root, ".story", "rulings", `${R4}.json`), JSON.stringify(merged, null, 2));
      const { rulings, unavailableIds } = loadRulingsSafe(root);
      const ctx = buildCitationResolutionContext(rulings, unavailableIds, "complete", false);
      expect(resolveCitation(R1, ctx).status).toBe("indeterminate");
      expect(resolveCitation(R4, ctx).status).toBe("nonaccepted");
      const verdict = await guardPlanNamesCitedRulings(root, "T-2", `# Plan\n\nPer ${R4}.`);
      expect(verdict.ok).toBe(false);
      expect(handleValidate(await ctxFor(root)).output).toContain("unresolved_conflicts");
    }
  });
});
