/**
 * T-527: KNOWLEDGE_REVIEW through the public guide.
 *
 * Every case drives handleAutonomousGuide (or the registered MCP tool) against
 * a real initialized project in a standalone temporary git repository
 * (ISS-1220): the FINALIZE commit that owes the review, the report that
 * accepts it, the downstream handover and session report, and the D6 parking
 * paths. KNOWLEDGE_REVIEW is an ordinary persisted stage: pre_compact compacts
 * it, a limit stop parks it for a headless resume, a resume without drift
 * re-enters it, drift keeps the pending review, and a branch reset shows up as
 * knowledge_diverged on the next report. The stage's rules themselves are in
 * test/autonomous/stages/knowledge-review.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "../mcp/tool-schema-helpers.js";
import { initProject } from "../../src/core/init.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, prepareForLimitStop, sessionDir, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState, type GuideInput } from "../../src/autonomous/session-types.js";
import { handleIssueCreate, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { handleSessionReport } from "../../src/cli/commands/session-report.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const DATE = "2026-09-22";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) {
    killSidecarsInRoot(r);
    rmSync(r, { recursive: true, force: true });
  }
});

/**
 * T-534: a resume of a limit park reads the retired runtime's global ledger.
 * Point the global dir at a scratch directory and seed a ledger whose only
 * attempt belongs to another session and has exited, so the read is real and
 * never touches the operator's ~/.claude.
 */
function isolateGlobalLedger(root: string): string {
  // Outside the repository, so no fixture commit's `git add -A` picks it up.
  const globalDir = mkdtempSync(join(tmpdir(), "kr-guide-global-"));
  roots.push(globalDir);
  vi.stubEnv("STORYBLOQ_GLOBAL_DIR", globalDir);
  const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
  const ledgerPath = join(globalDir, "limit-ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    records: {
      "claude:other-task": {
        clientTaskId: "other-task",
        projectRoot: root,
        storybloqSessionId: "00000000-0000-4000-8000-000000000000",
        attempt: { id: "a-other", childPid: deadPid },
      },
    },
  }));
  return ledgerPath;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" }).trim();
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
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
function writeCapabilities(root: string, capabilities: Record<string, unknown>[]): void {
  write(root, ".story/capabilities.json", JSON.stringify({ version: 1, capabilities }, null, 2) + "\n");
}

interface Fixture {
  root: string;
  issueId: string;
  displayId: string;
  base: string;
  impl: string;
}

/**
 * An initialized project with cap-core on `src/a.ts` and cap-old on the file
 * the issue renames, then the issue's implementation commit (the rename, an
 * edit and the issue resolved).
 */
async function setupProject(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "kr-guide-"));
  roots.push(root);
  await initProject(root, { name: "kr-guide" });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/old.ts", "export const old = 1;\n");
  writeCapabilities(root, [capability("cap-core", ["src/a.ts"]), capability("cap-old", ["src/old.ts"])]);
  const created = await handleIssueCreate(
    { title: "Old module is misnamed", severity: "low", impact: "src/old.ts is misnamed.", components: [], relatedTickets: [], location: ["src/old.ts"] },
    "json",
    root,
  );
  const data = (JSON.parse(created.output ?? "{}") as { data?: { id?: string; displayId?: string } }).data;
  if (!data?.id) throw new Error("issue fixture creation failed");
  const base = commit(root, "base");
  git(root, ["mv", "src/old.ts", "src/new.ts"]);
  write(root, "src/a.ts", "export const a = 2;\n");
  await handleIssueUpdate(data.id, { status: "resolved", resolution: "renamed" }, "json", root);
  const impl = commit(root, "implementation");
  return { root, issueId: data.id, displayId: data.displayId ?? data.id, base, impl };
}

/** A FINALIZE session that has passed precommit for the fixture's issue. */
function finalizeSession(fx: Fixture, overrides: Partial<FullSessionState> = {}): { sessionId: string; dir: string } {
  const session = createSession(fx.root, "coding", deriveWorkspaceId(fx.root));
  const dir = sessionDir(fx.root, session.sessionId);
  mkdirSync(dir, { recursive: true });
  writeSessionSync(dir, {
    ...session,
    state: "FINALIZE",
    finalizeCheckpoint: "precommit_passed",
    currentIssue: { id: fx.issueId, displayId: fx.displayId, title: "Old module is misnamed", severity: "low" },
    ticket: undefined,
    claimEpoch: null,
    itemAttempt: { id: "att-1", workItemId: fx.issueId, kind: "issue", startedAt: new Date().toISOString(), generation: 1 },
    config: { ...session.config, maxTicketsPerSession: 1 },
    git: { ...session.git, branch: "main", mergeBase: fx.base, expectedHead: fx.base, initHead: fx.base, itemBaseHead: fx.base },
    ...overrides,
  } as FullSessionState);
  return { sessionId: session.sessionId, dir };
}

function readState(dir: string): FullSessionState {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
}

async function guide(root: string, args: GuideInput): Promise<{ text: string; isError: boolean }> {
  const result = await handleAutonomousGuide(root, args);
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

function report(root: string, sessionId: string, body: Record<string, unknown>) {
  return guide(root, { sessionId, action: "report", report: body as unknown as GuideInput["report"] });
}

/** Commit through the guide: FINALIZE records the review and routes to KNOWLEDGE_REVIEW. */
async function commitDone(fx: Fixture, sessionId: string) {
  return report(fx.root, sessionId, { completedAction: "commit_done", commitHash: fx.impl, overrideAttribution: true });
}

function noneImpact(fx: Fixture, maintenanceCommits: string[] = []): Record<string, unknown> {
  return { implementationCommit: fx.impl, maintenanceCommits, checked: ["cap-core"], outcome: "none", reason: "nothing recorded changed" };
}

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}
function registeredGuide(root: string): RegisteredTool {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) =>
      tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  const tool = tools.get("storybloq_autonomous_guide");
  if (!tool) throw new Error("storybloq_autonomous_guide was not registered");
  return tool;
}
/** A report through the registered tool, parsed by its own input schema exactly as the MCP server does. */
async function mcpReport(root: string, sessionId: string, body: Record<string, unknown>) {
  const tool = registeredGuide(root);
  const args = toolSchema(tool.config.inputSchema).parse({ sessionId, action: "report", report: body });
  const result = await tool.handler(args as Record<string, unknown>);
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

// ---------------------------------------------------------------------------

describe("T-527 guide: the MCP boundary", () => {
  it("the registered tool's report schema declares knowledgeImpact", () => {
    const root = mkdtempSync(join(tmpdir(), "kr-guide-schema-"));
    roots.push(root);
    const schema = toolSchema(registeredGuide(root).config.inputSchema) as z.ZodObject<Record<string, z.ZodTypeAny>>;
    const reportSchema = schema.shape.report as z.ZodOptional<z.ZodObject<Record<string, z.ZodTypeAny>>>;
    expect(reportSchema.unwrap().shape.knowledgeImpact).toBeDefined();
  });
});

describe("T-527 guide: FINALIZE -> KNOWLEDGE_REVIEW -> COMPLETE -> HANDOVER", () => {
  it("accepts a maintained review over MCP and shows it in COMPLETE, the handover and the session report", async () => {
    const fx = await setupProject();
    const { sessionId, dir } = finalizeSession(fx);

    const owed = await commitDone(fx, sessionId);
    expect(owed.isError).toBe(false);
    expect(owed.text).toContain(`# Knowledge review: ${fx.displayId}`);
    // The renamed entry point is the strongest signal and is listed first.
    expect(owed.text).toMatch(/Stale capability entries[^\n]*\n- cap-old:/);
    const pending = readState(dir);
    expect(pending.state).toBe("KNOWLEDGE_REVIEW");
    expect(pending.knowledgeReview).toMatchObject({ itemId: fx.issueId, kind: "issue", itemAttemptId: "att-1", implementationCommit: fx.impl, status: "pending" });

    // A report with no knowledgeImpact is retried, over the real boundary.
    const bare = await mcpReport(fx.root, sessionId, { completedAction: "knowledge_reviewed" });
    expect(bare.text).toContain("knowledgeImpact is missing or invalid");
    expect(readState(dir).state).toBe("KNOWLEDGE_REVIEW");

    // The maintenance: cap-old follows the rename, in a ledger-only commit.
    writeCapabilities(fx.root, [capability("cap-core", ["src/a.ts"]), capability("cap-old", ["src/new.ts"], { checkedAt: { sha: fx.impl, date: DATE } })]);
    const m1 = commit(fx.root, "ledger: cap-old follows the rename");
    const accepted = await mcpReport(fx.root, sessionId, {
      completedAction: "knowledge_reviewed",
      knowledgeImpact: {
        implementationCommit: fx.impl,
        maintenanceCommits: [m1],
        checked: ["cap-old"],
        outcome: "impacts",
        impacts: [{ record: "cap-old", kind: "stale-reference", proposed: "entry point follows the rename", disposition: "applied", evidence: { record: "cap-old" } }],
      },
    });
    expect(accepted.isError).toBe(false);
    expect(accepted.text).toContain(`Knowledge review accepted for **${fx.displayId}**: 1 impact: 1 applied.`);
    const done = readState(dir);
    expect(done.state).toBe("HANDOVER");
    expect(done.knowledgeReview?.status).toBe("accepted");
    expect(done.knowledgeImpacts).toHaveLength(1);
    expect(done.knowledgeImpacts[0]).toMatchObject({ itemId: fx.issueId, itemAttemptId: "att-1", implementationCommit: fx.impl, headAtAcceptance: m1, maintenanceCommits: [m1] });
    const events = readFileSync(join(dir, "events.log"), "utf-8");
    expect(events).toContain("\"knowledge_reviewed\"");

    const handover = await report(fx.root, sessionId, { completedAction: "handover_written", handoverContent: "# Session\n\nRenamed the old module.\n" });
    expect(handover.isError).toBe(false);
    const handoverDir = join(fx.root, ".story", "handovers");
    const files = readdirSync(handoverDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    const written = readFileSync(join(handoverDir, files[0]!), "utf-8");
    expect(written).toContain("Renamed the old module.");
    expect(written).toContain("## Knowledge impact");
    expect(written).toContain(`### ${fx.displayId} (issue, committed at ${fx.impl.slice(0, 12)})`);
    expect(written).toContain(`- Maintenance commits: ${m1.slice(0, 12)}`);

    const md = await handleSessionReport(sessionId, fx.root, "md");
    expect(md.output).toContain("## Knowledge Impact");
    expect(md.output).toContain(`### ${fx.displayId} (issue, committed at ${fx.impl.slice(0, 12)})`);
    const json = JSON.parse((await handleSessionReport(sessionId, fx.root, "json")).output ?? "{}") as { data?: { knowledgeImpacts?: unknown[] } } & { knowledgeImpacts?: unknown[] };
    const impacts = json.data?.knowledgeImpacts ?? json.knowledgeImpacts;
    expect(impacts).toHaveLength(1);
  });

  it("with code review off and zero findings the committed issue still owes its review", async () => {
    const fx = await setupProject();
    const session = finalizeSession(fx);
    const state = readState(session.dir);
    writeSessionSync(session.dir, {
      ...state,
      config: { ...state.config, reviewBackends: [] },
      currentReviewEffort: "off",
      reviews: { plan: [], code: [] },
    } as FullSessionState);
    const owed = await commitDone(fx, session.sessionId);
    expect(owed.text).toContain(`# Knowledge review: ${fx.displayId}`);
    expect(readState(session.dir).state).toBe("KNOWLEDGE_REVIEW");
  });
});

describe("T-527 guide: a FINALIZE state that already committed", () => {
  it("routes a pending review to KNOWLEDGE_REVIEW, and a pre-1.16 state (no field) to COMPLETE", async () => {
    const fx = await setupProject();
    const committed: Partial<FullSessionState> = {
      finalizeCheckpoint: "committed",
      finalizedItem: { kind: "issue", id: fx.issueId, commitHash: fx.impl },
      currentIssue: undefined,
      resolvedIssues: [fx.issueId],
      resolvedIssueDisplayIds: { [fx.issueId]: fx.displayId },
    } as Partial<FullSessionState>;
    const pending = finalizeSession(fx, {
      ...committed,
      knowledgeReview: { itemId: fx.issueId, kind: "issue", itemAttemptId: "att-1", implementationCommit: fx.impl, checkpoint: fx.impl, status: "pending" },
    } as Partial<FullSessionState>);
    const owed = await commitDone(fx, pending.sessionId);
    expect(owed.text).toContain(`# Knowledge review: ${fx.displayId}`);
    expect(readState(pending.dir).state).toBe("KNOWLEDGE_REVIEW");

    // Written by a build without the field: nothing is owed, the item completes.
    const legacy = finalizeSession(fx, committed);
    const raw = readState(legacy.dir) as unknown as Record<string, unknown>;
    delete raw.knowledgeReview;
    delete raw.knowledgeImpacts;
    writeFileSync(join(legacy.dir, "state.json"), JSON.stringify(raw, null, 2) + "\n");
    const completed = await commitDone(fx, legacy.sessionId);
    expect(completed.isError).toBe(false);
    expect(completed.text).not.toContain("# Knowledge review");
    expect(readState(legacy.dir).state).not.toBe("KNOWLEDGE_REVIEW");
  });
});

describe("T-527 guide (D6): KNOWLEDGE_REVIEW is an ordinary persisted stage", () => {
  it("pre_compact parks it and a resume without drift re-enters it with the review kept", async () => {
    const fx = await setupProject();
    const { sessionId, dir } = finalizeSession(fx);
    await commitDone(fx, sessionId);
    const review = readState(dir).knowledgeReview;

    const parked = await guide(fx.root, { sessionId, action: "pre_compact" });
    expect(parked.isError).toBe(false);
    expect(readState(dir)).toMatchObject({ state: "COMPACT", preCompactState: "KNOWLEDGE_REVIEW", knowledgeReview: review });

    const resumed = await guide(fx.root, { sessionId, action: "resume" });
    expect(resumed.isError).toBe(false);
    expect(resumed.text).toContain("Session restored at state: **KNOWLEDGE_REVIEW**");
    expect(resumed.text).toContain(`# Knowledge review: ${fx.displayId}`);
    expect(readState(dir)).toMatchObject({ state: "KNOWLEDGE_REVIEW", knowledgeReview: review });

    const accepted = await report(fx.root, sessionId, { completedAction: "knowledge_reviewed", knowledgeImpact: noneImpact(fx) });
    expect(accepted.text).toContain(`Knowledge review accepted for **${fx.displayId}**: none.`);
  });

  it("a limit stop resumes headless into the stage (not the FINALIZE refusal), and a same-key report after the resume is idempotent", async () => {
    const fx = await setupProject();
    const ledgerPath = isolateGlobalLedger(fx.root);
    const ledgerBefore = readFileSync(ledgerPath, "utf-8");
    const { sessionId, dir } = finalizeSession(fx);
    await commitDone(fx, sessionId);
    const review = readState(dir).knowledgeReview;

    const result = prepareForLimitStop(dir, readState(dir), { resumeAt: Date.now() + 60_000, limitEventId: "limit-evt-527" });
    expect(result.preCompactState).toBe("KNOWLEDGE_REVIEW");
    expect(readState(dir)).toMatchObject({ state: "COMPACT", interruptionKind: "limit", knowledgeReview: review });

    // The waker's headless resume is a plain guide resume.
    const resumed = await guide(fx.root, { sessionId, action: "resume" });
    expect(resumed.isError).toBe(false);
    expect(resumed.text).not.toContain("stopped by a usage limit during FINALIZE");
    expect(resumed.text).toContain(`# Knowledge review: ${fx.displayId}`);
    expect(readState(dir)).toMatchObject({ state: "KNOWLEDGE_REVIEW", knowledgeReview: review });
    expect(readFileSync(ledgerPath, "utf-8")).toBe(ledgerBefore);

    const body = { completedAction: "knowledge_reviewed", knowledgeImpact: noneImpact(fx) };
    const first = await report(fx.root, sessionId, body);
    expect(first.text).toContain("Knowledge review accepted");
    const afterFirst = readState(dir);
    expect(afterFirst.knowledgeImpacts).toHaveLength(1);

    // The same (itemAttemptId, implementationCommit) again: nothing is stored twice.
    const replay = await report(fx.root, sessionId, body);
    expect(replay.text).not.toContain("Knowledge review accepted");
    const afterReplay = readState(dir);
    expect(afterReplay.knowledgeImpacts).toEqual(afterFirst.knowledgeImpacts);
    expect(afterReplay.knowledgeReview).toEqual(afterFirst.knowledgeReview);
  });

  it("an acceptance whose response was lost to a limit stop is not stored twice when the report is replayed after the resume", async () => {
    const fx = await setupProject();
    isolateGlobalLedger(fx.root);
    const { sessionId, dir } = finalizeSession(fx);
    await commitDone(fx, sessionId);
    const body = { completedAction: "knowledge_reviewed", knowledgeImpact: noneImpact(fx) };
    await report(fx.root, sessionId, body);
    const accepted = readState(dir);
    expect(accepted.knowledgeImpacts).toHaveLength(1);

    prepareForLimitStop(dir, accepted, { resumeAt: Date.now() + 60_000, limitEventId: "limit-evt-527b" });
    const resumed = await guide(fx.root, { sessionId, action: "resume" });
    expect(resumed.isError).toBe(false);
    await report(fx.root, sessionId, body);
    const after = readState(dir);
    expect(after.knowledgeImpacts).toEqual(accepted.knowledgeImpacts);
    expect(after.state).not.toBe("KNOWLEDGE_REVIEW");
  });

  it("drift during the park recovers to the stage with the review kept; the later code is rebased before acceptance", async () => {
    const fx = await setupProject();
    const { sessionId, dir } = finalizeSession(fx);
    await commitDone(fx, sessionId);
    const review = readState(dir).knowledgeReview;

    // A later commit the park observes, then replaced by another line of work.
    write(fx.root, "src/b.ts", "export const b = 1;\n");
    commit(fx.root, "observed at the park");
    await guide(fx.root, { sessionId, action: "pre_compact" });
    git(fx.root, ["reset", "-q", "--hard", fx.impl]);
    write(fx.root, "src/c.ts", "export const c = 1;\n");
    const later = commit(fx.root, "replacement work");

    const resumed = await guide(fx.root, { sessionId, action: "resume" });
    expect(resumed.isError).toBe(false);
    expect(resumed.text).toContain("Recovered to **KNOWLEDGE_REVIEW**");
    expect(resumed.text).toContain(`# Knowledge review: ${fx.displayId}`);
    expect(readState(dir)).toMatchObject({ state: "KNOWLEDGE_REVIEW", knowledgeReview: review });

    const body = { completedAction: "knowledge_reviewed", knowledgeImpact: noneImpact(fx) };
    const refused = await report(fx.root, sessionId, body);
    expect(refused.text).toContain("Knowledge review not accepted");
    expect(readState(dir).knowledgeReview?.status).toBe("pending");

    const rebased = await report(fx.root, sessionId, { completedAction: "knowledge_rebase" });
    expect(rebased.text).toContain(`Checkpoint moved to ${later.slice(0, 12)}`);
    const accepted = await report(fx.root, sessionId, body);
    expect(accepted.text).toContain("Knowledge review accepted");
    expect(readState(dir).knowledgeImpacts[0]?.checkpoints).toEqual([fx.impl, later]);
  });

  it("a branch reset past the implementation commit is knowledge_diverged on the next report", async () => {
    const fx = await setupProject();
    const { sessionId, dir } = finalizeSession(fx);
    await commitDone(fx, sessionId);
    git(fx.root, ["reset", "-q", "--hard", fx.base]);

    const diverged = await report(fx.root, sessionId, { completedAction: "knowledge_reviewed", knowledgeImpact: noneImpact(fx) });
    expect(diverged.text).toContain("knowledge_diverged");
    expect(readState(dir)).toMatchObject({ state: "KNOWLEDGE_REVIEW" });
    expect(readState(dir).knowledgeReview?.status).toBe("pending");
    expect(readState(dir).knowledgeImpacts).toEqual([]);
  });
});
