import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleIssueList,
  handleIssueGet,
  handleIssueCreate,
  handleIssueUpdate,
  handleIssueMetaGet,
  handleIssueMetaSet,
  handleIssueMetaUnset,
  handleIssueDelete,
} from "../../../src/cli/commands/issue.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError, todayISO } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { makeState, makeIssue } from "../../core/test-factories.js";
import { deriveWorkspaceId } from "../../../src/autonomous/session-types.js";
import type { CommandContext } from "../../../src/cli/run.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

async function enableTeamMode(dir: string): Promise<void> {
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.team = { ...(config.team ?? {}), enabled: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

describe("handleIssueList", () => {
  it("returns all issues with no filters", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", title: "Bug A" }),
          makeIssue({ id: "ISS-002", title: "Bug B" }),
        ],
      }),
    });
    const result = handleIssueList({}, ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).toContain("ISS-002");
  });

  it("filters by status", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", status: "open" }),
          makeIssue({ id: "ISS-002", status: "resolved" }),
        ],
      }),
    });
    const result = handleIssueList({ status: "open" }, ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).not.toContain("ISS-002");
  });

  it("filters by severity", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", severity: "high" }),
          makeIssue({ id: "ISS-002", severity: "low" }),
        ],
      }),
    });
    const result = handleIssueList({ severity: "high" }, ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).not.toContain("ISS-002");
  });

  it("throws on invalid status filter", () => {
    const ctx = makeCtx();
    expect(() => handleIssueList({ status: "invalid" }, ctx)).toThrow(CliValidationError);
  });

  it("throws on invalid severity filter", () => {
    const ctx = makeCtx();
    expect(() => handleIssueList({ severity: "invalid" }, ctx)).toThrow(CliValidationError);
  });

  it("filters by component matches", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", components: ["ui", "api"] }),
          makeIssue({ id: "ISS-002", components: ["core"] }),
        ],
      }),
    });
    const result = handleIssueList({ component: "ui" }, ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).not.toContain("ISS-002");
  });

  it("filters by component no matches", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", components: ["ui"] }),
        ],
      }),
    });
    const result = handleIssueList({ component: "nonexistent" }, ctx);
    expect(result.output).not.toContain("ISS-001");
  });

  it("returns empty message when no issues", () => {
    const ctx = makeCtx();
    const result = handleIssueList({}, ctx);
    expect(result.output).toContain("No issues");
  });

  it("returns valid JSON", () => {
    const ctx = makeCtx({ format: "json" });
    const result = handleIssueList({}, ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  // ISS-739 (GitHub #13): phase filter, mirroring handleTicketList semantics:
  // no roadmap validation at the CLI layer, unknown phase yields an empty
  // list with exit 0 (validation lives in the MCP tool closure, like
  // storybloq_ticket_list).
  it("filters by phase (ISS-739)", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", phase: "p1" }),
          makeIssue({ id: "ISS-002", phase: "p2" }),
          makeIssue({ id: "ISS-003" }),
        ],
      }),
    });
    const result = handleIssueList({ phase: "p1" }, ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).not.toContain("ISS-002");
    expect(result.output).not.toContain("ISS-003");
  });

  it("unknown phase returns an empty list with exit 0, like ticket list (ISS-739)", () => {
    const ctx = makeCtx({
      state: makeState({ issues: [makeIssue({ id: "ISS-001", phase: "p1" })] }),
    });
    const result = handleIssueList({ phase: "bogus" }, ctx);
    expect(result.output).toBe("No issues found.");
    expect(result.exitCode).toBeUndefined();
  });

  it("phase filter composes with severity as AND (ISS-739)", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001", phase: "p1", severity: "high" }),
          makeIssue({ id: "ISS-002", phase: "p1", severity: "low" }),
          makeIssue({ id: "ISS-003", phase: "p2", severity: "high" }),
        ],
      }),
    });
    const result = handleIssueList({ phase: "p1", severity: "high" }, ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).not.toContain("ISS-002");
    expect(result.output).not.toContain("ISS-003");
  });
});

describe("handleIssueGet", () => {
  it("returns issue when found", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [makeIssue({ id: "ISS-001", title: "My Bug" })],
      }),
    });
    const result = handleIssueGet("ISS-001", ctx);
    expect(result.output).toContain("ISS-001");
    expect(result.output).toContain("My Bug");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns not_found when missing", () => {
    const ctx = makeCtx();
    const result = handleIssueGet("ISS-999", ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });
});

// --- Write Handler Tests ---

describe("handleIssueCreate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("creates an issue and writes to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleIssueCreate(
      { title: "New Bug", severity: "high", impact: "broken", components: [], relatedTickets: [], location: [] },
      "md", dir,
    );
    expect(result.output).toContain("Created issue ISS-001");
    const raw = await readFile(join(dir, ".story", "issues", "ISS-001.json"), "utf-8");
    const issue = JSON.parse(raw);
    expect(issue.title).toBe("New Bug");
    expect(issue.status).toBe("open");
  });

  it("creates canonical IDs with display IDs in explicit team mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await enableTeamMode(dir);

    const result = await handleIssueCreate(
      { title: "Team Bug", severity: "high", impact: "broken", components: [], relatedTickets: [], location: [] },
      "json", dir,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.data.id).toMatch(/^i-[a-z0-9]{16}$/);
    expect(parsed.data.displayId).toBe("ISS-001");
    expect(parsed.data.createdAt).toEqual(expect.any(String));
    const raw = await readFile(join(dir, ".story", "issues", `${parsed.data.id}.json`), "utf-8");
    const issue = JSON.parse(raw);
    expect(issue.title).toBe("Team Bug");
    await expect(readFile(join(dir, ".story", "issues", "ISS-001.json"), "utf-8")).rejects.toThrow();
  });

  it("auto-allocates sequential IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "First", severity: "high", impact: "x", components: [], relatedTickets: [], location: [] },
      "md", dir,
    );
    const result = await handleIssueCreate(
      { title: "Second", severity: "low", impact: "y", components: [], relatedTickets: [], location: [] },
      "md", dir,
    );
    expect(result.output).toContain("ISS-002");
  });

  it("returns valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleIssueCreate(
      { title: "Test", severity: "medium", impact: "x", components: [], relatedTickets: [], location: [] },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.id).toBe("ISS-001");
  });

  it("rejects invalid severity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleIssueCreate(
        { title: "Test", severity: "invalid", impact: "x", components: [], relatedTickets: [], location: [] },
        "md", dir,
      ),
    ).rejects.toThrow(CliValidationError);
  });

  it("sets discoveredDate to today", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleIssueCreate(
      { title: "Test", severity: "high", impact: "x", components: [], relatedTickets: [], location: [] },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.discoveredDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("defaults location to empty array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleIssueCreate(
      { title: "Test", severity: "high", impact: "x", components: [], relatedTickets: [], location: [] },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.location).toEqual([]);
  });

  it("accepts valid phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleIssueCreate(
      { title: "Phased", severity: "high", impact: "x", components: [], relatedTickets: [], location: [], phase: "p0" },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.phase).toBe("p0");
  });

  it("captures structured source provenance without storing source text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await writeFile(join(dir, "source.ts"), "one\ntwo\nthree\n", "utf8");

    const result = await handleIssueCreate(
      {
        title: "Anchored",
        severity: "high",
        impact: "broken",
        components: [],
        relatedTickets: [],
        location: ["source.ts:2"],
        sourceRefs: [{ path: "source.ts", startLine: 2, reviewId: "review-1" }],
        createdBy: "external-reviewer",
      },
      "json",
      dir,
    );

    const issue = JSON.parse(result.output).data;
    expect(issue.createdBy).toBe("external-reviewer");
    expect(issue.sourceRefs).toEqual([
      expect.objectContaining({
        path: "source.ts",
        startLine: 2,
        reviewId: "review-1",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(JSON.stringify(issue)).not.toContain("two");
  });

  it("returns the existing issue for a repeated dedupe key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const args = {
      title: "One finding",
      severity: "medium",
      impact: "broken",
      components: [],
      relatedTickets: [],
      location: [],
      dedupeKey: "review:file.ts:4:error-handling",
    };

    const first = JSON.parse((await handleIssueCreate(args, "json", dir)).output);
    const second = JSON.parse((await handleIssueCreate(args, "json", dir)).output);
    const files = await readdir(join(dir, ".story", "issues"));

    expect(second.data.id).toBe(first.data.id);
    expect(second.meta).toEqual({ deduplicated: true });
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
  });

  it("deduplicates before re-reading source evidence on a retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const sourcePath = join(dir, "source.ts");
    await writeFile(sourcePath, "one\ntwo\n", "utf8");
    const args = {
      title: "One finding",
      severity: "medium",
      impact: "broken",
      components: [],
      relatedTickets: [],
      location: ["source.ts:2"],
      sourceRefs: [{ path: "source.ts", startLine: 2 }],
      dedupeKey: "review:source.ts:2:error-handling",
    };

    const first = JSON.parse((await handleIssueCreate(args, "json", dir)).output);
    await rm(sourcePath);
    const second = JSON.parse((await handleIssueCreate(args, "json", dir)).output);

    expect(second.data.id).toBe(first.data.id);
    expect(second.meta).toEqual({ deduplicated: true });
  });

  it("does not deduplicate a new finding onto a deleted team-mode issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await enableTeamMode(dir);
    const args = {
      title: "Recurring finding",
      severity: "high",
      impact: "broken",
      components: [],
      relatedTickets: [],
      location: [],
      dedupeKey: "review:recurring-finding",
    };

    const first = JSON.parse((await handleIssueCreate(args, "json", dir)).output).data;
    await handleIssueDelete(first.id, "md", dir);
    const second = JSON.parse((await handleIssueCreate(args, "json", dir)).output);
    const { state } = await loadProject(dir);

    expect(second.meta).toBeUndefined();
    expect(second.data.id).not.toBe(first.id);
    expect(second.data.lifecycle).not.toBe("deleted");
    expect(state.activeIssues.map((issue) => issue.id)).toEqual([second.data.id]);
  });

  it("rejects nonexistent phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleIssueCreate(
        { title: "Bad phase", severity: "high", impact: "x", components: [], relatedTickets: [], location: [], phase: "nonexistent" },
        "md", dir,
      ),
    ).rejects.toThrow("not found in roadmap");
  });

  describe("ISS-1203: phase inference so issues with no explicit phase still appear on the phase-grouped board", () => {
    it("infers phase from the first related ticket", async () => {
      const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      const ticket = JSON.parse((await handleTicketCreate(
        { title: "Leaf", type: "task", phase: "p0", description: "x", blockedBy: [], parentTicket: null },
        "json", dir,
      )).output).data;

      const result = await handleIssueCreate(
        { title: "Bug", severity: "high", impact: "x", components: [], relatedTickets: [ticket.id], location: [] },
        "json", dir,
      );

      expect(JSON.parse(result.output).data.phase).toBe("p0");
    });

    it("falls back to the resolved parent's phase when a related child ticket has no phase of its own", async () => {
      const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      const umbrella = JSON.parse((await handleTicketCreate(
        { title: "Umbrella", type: "feature", phase: "p0", description: "x", blockedBy: [], parentTicket: null },
        "json", dir,
      )).output).data;
      const child = JSON.parse((await handleTicketCreate(
        { title: "Child", type: "task", phase: null, description: "x", blockedBy: [], parentTicket: umbrella.id },
        "json", dir,
      )).output).data;
      expect(child.phase).toBeNull();

      const result = await handleIssueCreate(
        { title: "Bug", severity: "high", impact: "x", components: [], relatedTickets: [child.id], location: [] },
        "json", dir,
      );

      expect(JSON.parse(result.output).data.phase).toBe("p0");
    });

    it("stays phase-less with no related tickets and no active session", async () => {
      const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });

      const result = await handleIssueCreate(
        { title: "Bug", severity: "high", impact: "x", components: [], relatedTickets: [], location: [] },
        "json", dir,
      );

      expect(JSON.parse(result.output).data.phase).toBeNull();
    });

    it("uses the active session's current ticket phase when relatedTickets is empty", async () => {
      const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
      tmpDirs.push(dir);
      await initProject(dir, { name: "test" });
      const ticket = JSON.parse((await handleTicketCreate(
        { title: "In progress", type: "task", phase: "p0", description: "x", blockedBy: [], parentTicket: null },
        "json", dir,
      )).output).data;

      const sessionId = "aaaaaaaa-0000-0000-0000-000000000001";
      const sessDir = join(dir, ".story", "sessions", sessionId);
      await mkdir(sessDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(join(sessDir, "state.json"), JSON.stringify({
        schemaVersion: 1,
        sessionId,
        recipe: "coding",
        state: "IMPLEMENT",
        revision: 1,
        status: "active",
        mode: "auto",
        reviews: { plan: [], code: [] },
        completedTickets: [],
        finalizeCheckpoint: null,
        git: { branch: "main", mergeBase: null },
        lease: {
          workspaceId: deriveWorkspaceId(dir),
          lastHeartbeat: now,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        },
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
        guideCallCount: 0,
        config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
        ticket: { id: ticket.id, title: ticket.title },
      }));
      await writeFile(join(sessDir, "events.log"), "");

      const result = await handleIssueCreate(
        { title: "Deferred finding", severity: "high", impact: "x", components: [], relatedTickets: [], location: [] },
        "json", dir,
      );

      expect(JSON.parse(result.output).data.phase).toBe("p0");
    });

    it("does not override an explicit phase with an inferred one", async () => {
      const dir = await mkdtemp(join(tmpdir(), "issue-create-"));
      tmpDirs.push(dir);
      await initProject(dir, {
        name: "test",
        phases: [
          { id: "p0", label: "PHASE 0", name: "Setup", description: "x" },
          { id: "p1", label: "PHASE 1", name: "Next", description: "y" },
        ],
      });
      const ticket = JSON.parse((await handleTicketCreate(
        { title: "Leaf", type: "task", phase: "p0", description: "x", blockedBy: [], parentTicket: null },
        "json", dir,
      )).output).data;

      const result = await handleIssueCreate(
        { title: "Bug", severity: "high", impact: "x", components: [], relatedTickets: [ticket.id], location: [], phase: "p1" },
        "json", dir,
      );

      expect(JSON.parse(result.output).data.phase).toBe("p1");
    });
  });
});

describe("handleIssueUpdate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupIssue(dir: string) {
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "Original Bug", severity: "high", impact: "broken", components: ["core"], relatedTickets: [], location: [] },
      "md", dir,
    );
  }

  it("updates severity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const result = await handleIssueUpdate("ISS-001", { severity: "low" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.severity).toBe("low");
  });

  it("strips a whole-input 4+ backtick render fence from impact and warns (ISS-1192)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const inner = "impact line one\n```ts\ncode\n```\nline three";
    const rendered = `\`\`\`\`\n${inner}\n\`\`\`\``;
    const result = await handleIssueUpdate("ISS-001", { impact: rendered }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.impact).toBe(inner);
    expect(result.warnings).toEqual(["outer render fence removed; use --format json for round trips"]);
  });

  it("leaves a 3-backtick whole-impact fence untouched, with no warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const input = "```\nhello\n```";
    const result = await handleIssueUpdate("ISS-001", { impact: input }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.impact).toBe(input);
    expect(result.warnings).toBeUndefined();
  });

  it("clearEarmarkForSession clears a same-session earmark atomically with the status write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const issuePath = join(dir, ".story", "issues", "ISS-001.json");
    const issue = JSON.parse(await readFile(issuePath, "utf-8"));
    issue.status = "inprogress";
    issue.earmark = {
      stage: "assigned", reservedBy: { client: "claude", id: "pen-task-1" },
      arrangementId: "a-0123456789abcdef", since: "2026-08-28T00:00:00.000Z",
      holderRole: "worker", holderSession: sessionId,
    };
    await writeFile(issuePath, JSON.stringify(issue, null, 2), "utf-8");

    const result = await handleIssueUpdate("ISS-001", { status: "open" }, "json", dir, {
      clearEarmarkForSession: sessionId,
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("open");
    expect(parsed.data.earmark).toBeNull();
  });

  it("clearEarmarkForSession leaves a different session's earmark untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const foreignEarmark = {
      stage: "assigned", reservedBy: { client: "claude", id: "pen-task-1" },
      arrangementId: "a-0123456789abcdef", since: "2026-08-28T00:00:00.000Z",
      holderRole: "worker", holderSession: "22222222-2222-4222-8222-222222222222",
    };
    const issuePath = join(dir, ".story", "issues", "ISS-001.json");
    const issue = JSON.parse(await readFile(issuePath, "utf-8"));
    issue.status = "inprogress";
    issue.earmark = foreignEarmark;
    await writeFile(issuePath, JSON.stringify(issue, null, 2), "utf-8");

    const result = await handleIssueUpdate("ISS-001", { status: "open" }, "json", dir, {
      clearEarmarkForSession: "11111111-1111-4111-8111-111111111111",
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("open");
    expect(parsed.data.earmark).toEqual(foreignEarmark);
  });

  it("resolved sets resolvedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const result = await handleIssueUpdate("ISS-001", { status: "resolved", resolution: "fixed" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.resolvedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("open clears resolvedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    await handleIssueUpdate("ISS-001", { status: "resolved", resolution: "fixed" }, "md", dir);
    const result = await handleIssueUpdate("ISS-001", { status: "open" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.resolvedDate).toBeNull();
  });

  it("resolved→resolved preserves resolvedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    await handleIssueUpdate("ISS-001", { status: "resolved", resolution: "fixed" }, "md", dir);
    const result = await handleIssueUpdate("ISS-001", { title: "Renamed" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.resolvedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns not_found for missing issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleIssueUpdate("ISS-999", { title: "X" }, "md", dir),
    ).rejects.toThrow("not found");
  });

  it("replaces components array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const result = await handleIssueUpdate("ISS-001", { components: ["ui", "api"] }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.components).toEqual(["ui", "api"]);
  });

  it("updates order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const result = await handleIssueUpdate("ISS-001", { order: 42 }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.order).toBe(42);
  });

  it("updates phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    const result = await handleIssueUpdate("ISS-001", { phase: "p0" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.phase).toBe("p0");
  });

  it("replaces and normalizes structured source provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    await writeFile(join(dir, "source.ts"), "one\ntwo\n", "utf8");

    const result = await handleIssueUpdate(
      "ISS-001",
      { sourceRefs: [{ path: "source.ts", startLine: 2 }] },
      "json",
      dir,
    );

    expect(JSON.parse(result.output).data.sourceRefs[0]).toEqual(
      expect.objectContaining({
        path: "source.ts",
        startLine: 2,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("clears phase to null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    await handleIssueUpdate("ISS-001", { phase: "p0" }, "md", dir);
    const result = await handleIssueUpdate("ISS-001", { phase: null }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.phase).toBeNull();
  });

  it("rejects invalid phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-update-"));
    tmpDirs.push(dir);
    await setupIssue(dir);
    await expect(
      handleIssueUpdate("ISS-001", { phase: "nonexistent" }, "md", dir),
    ).rejects.toThrow("not found in roadmap");
  });
});

describe("handleIssueMeta", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupIssue(dir: string) {
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "Original Bug", severity: "high", impact: "broken", components: ["core"], relatedTickets: [], location: [] },
      "md", dir,
    );
  }

  async function loadCtx(dir: string, format: "md" | "json" = "json"): Promise<CommandContext> {
    const { state, warnings } = await loadProject(dir);
    return {
      state,
      warnings,
      root: dir,
      handoversDir: join(dir, ".story", "handovers"),
      format,
    };
  }

  it("sets and gets custom issue metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-meta-"));
    tmpDirs.push(dir);
    await setupIssue(dir);

    const setResult = await handleIssueMetaSet("ISS-001", "source", "customer-report", "json", dir);
    expect(JSON.parse(setResult.output).data.source).toBe("customer-report");

    const getResult = handleIssueMetaGet("ISS-001", "source", await loadCtx(dir));
    expect(JSON.parse(getResult.output).data).toBe("customer-report");
  });

  it("sets nested issue metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-meta-"));
    tmpDirs.push(dir);
    await setupIssue(dir);

    await handleIssueMetaSet("ISS-001", "integrations.external.id", "BUG-123", "json", dir);
    const getResult = handleIssueMetaGet("ISS-001", "integrations", await loadCtx(dir));
    expect(JSON.parse(getResult.output).data).toEqual({ external: { id: "BUG-123" } });
  });

  it("unsets custom issue metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-meta-"));
    tmpDirs.push(dir);
    await setupIssue(dir);

    await handleIssueMetaSet("ISS-001", "source", "customer-report", "json", dir);
    const unsetResult = await handleIssueMetaUnset("ISS-001", "source", "json", dir);
    expect(JSON.parse(unsetResult.output).data.source).toBeUndefined();
  });

  it("rejects protected issue fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-meta-"));
    tmpDirs.push(dir);
    await setupIssue(dir);

    await expect(
      handleIssueMetaSet("ISS-001", "severity", "low", "json", dir),
    ).rejects.toThrow(CliValidationError);
  });
});

describe("handleIssueDelete", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("deletes an issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "Doomed", severity: "low", impact: "minor", components: [], relatedTickets: [], location: [] },
      "md", dir,
    );
    const result = await handleIssueDelete("ISS-001", "md", dir);
    expect(result.output).toContain("Deleted issue ISS-001");
  });
});

describe("T-476 section 10: setting citesRulings via create/update", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const R1 = "r-0000000000000001";
  const R2 = "r-0000000000000002";

  it("create: citesRuling is deduplicated preserving first-seen order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-cites-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleIssueCreate(
      { title: "i", severity: "low", impact: "x", components: [], relatedTickets: [], location: [], citesRuling: [R2, R1, R2] },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.citesRulings).toEqual([R2, R1]);
  });

  it("update: citesRuling fully replaces the existing array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-cites-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "i", severity: "low", impact: "x", components: [], relatedTickets: [], location: [], citesRuling: [R1] },
      "json", dir,
    );
    const result = await handleIssueUpdate("ISS-001", { citesRuling: [R2] }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.citesRulings).toEqual([R2]);
  });

  it("update: clearCitesRulings empties the array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-cites-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "i", severity: "low", impact: "x", components: [], relatedTickets: [], location: [], citesRuling: [R1] },
      "json", dir,
    );
    const result = await handleIssueUpdate("ISS-001", { clearCitesRulings: true }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.citesRulings).toEqual([]);
  });

  it("update: citesRuling and clearCitesRulings together are refused as invalid_input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-cites-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "i", severity: "low", impact: "x", components: [], relatedTickets: [], location: [] },
      "json", dir,
    );
    await expect(
      handleIssueUpdate("ISS-001", { citesRuling: [R1], clearCitesRulings: true }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("update: an invalid ruling id shape is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-cites-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "i", severity: "low", impact: "x", components: [], relatedTickets: [], location: [] },
      "json", dir,
    );
    await expect(
      handleIssueUpdate("ISS-001", { citesRuling: ["not-a-ruling"] }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });
});

describe("handleIssueCreate validation texts and precedence are unchanged by ISS-1221", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  async function project(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "issue-create-texts-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    return dir;
  }
  const base = { title: "Bug", impact: "x", components: [], relatedTickets: [], location: [] };

  it("pins the three invalid_input texts literally", async () => {
    const dir = await project();
    await expect(handleIssueCreate({ ...base, severity: "urgent" }, "json", dir))
      .rejects.toThrow('Unknown issue severity "urgent": must be one of critical, high, medium, low');
    await expect(handleIssueCreate({ ...base, severity: "high", dedupeKey: "k".repeat(513) }, "json", dir))
      .rejects.toThrow(/512/);
    await expect(handleIssueCreate({ ...base, severity: "high", phase: "p9" }, "json", dir))
      .rejects.toThrow('Phase "p9" not found in roadmap');
  });

  it("a bad citesRuling still wins over a bad dedupe key (severity, citesRuling, dedupeKey order)", async () => {
    const dir = await project();
    const citesOnly = await handleIssueCreate({ ...base, severity: "high", citesRuling: ["nope"] }, "json", dir).catch((e: Error) => e.message);
    expect(citesOnly).toMatch(/Invalid ruling ID/);
    const compound = await handleIssueCreate({ ...base, severity: "high", citesRuling: ["nope"], dedupeKey: "k".repeat(513) }, "json", dir).catch((e: Error) => e.message);
    expect(compound).toBe(citesOnly);
  });

  it("a repeated dedupe key returns the existing issue before the phase is validated", async () => {
    const dir = await project();
    const first = JSON.parse((await handleIssueCreate({ ...base, severity: "high", dedupeKey: "dk-order" }, "json", dir)).output).data;
    const again = JSON.parse((await handleIssueCreate({ ...base, severity: "high", dedupeKey: "dk-order", phase: "p9" }, "json", dir)).output).data;
    expect(again.id).toBe(first.id);
  });

  it("an empty-string phase is still refused by write validation, not by the roadmap check", async () => {
    const dir = await project();
    await expect(handleIssueCreate({ ...base, severity: "high", phase: "" }, "json", dir))
      .rejects.toThrow('references unknown phase ""');
  });
});

// T-481 T4: priority and waitingOn through the issue CLI handlers, and the
// updatedDate stamp on an edit and on a status change.
describe("T-481 T4: issue priority, waitingOn and updatedDate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setup(): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "t481-t4-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleIssueCreate(
      { title: "Bug", severity: "high", impact: "broken", components: ["core"], relatedTickets: [], location: [] },
      "md", dir,
    );
    const issuesDir = join(dir, ".story", "issues");
    const name = (await readdir(issuesDir)).find((f) => f.endsWith(".json"))!;
    const file = join(issuesDir, name);
    const record = JSON.parse(await readFile(file, "utf-8"));
    await writeFile(file, JSON.stringify({ ...record, updatedDate: "2020-01-01" }, null, 2) + "\n", "utf-8");
    return { dir, file };
  }
  const read = async (file: string) => JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;

  it("--severity stamps today's local date", async () => {
    const { dir, file } = await setup();
    await handleIssueUpdate("ISS-001", { severity: "low" }, "json", dir);
    const i = await read(file);
    expect(i.severity).toBe("low");
    expect(i.updatedDate).toBe(todayISO());
  });

  it("--status resolved stamps today's local date", async () => {
    const { dir, file } = await setup();
    await handleIssueUpdate("ISS-001", { status: "resolved", resolution: "Fixed." }, "json", dir);
    const i = await read(file);
    expect(i.status).toBe("resolved");
    expect(i.updatedDate).toBe(todayISO());
  });

  it("--priority p1 and --waiting-on external are stored; --waiting-on none removes the key", async () => {
    const { dir, file } = await setup();
    await handleIssueUpdate("ISS-001", { priority: "p1", waitingOn: "external" } as never, "json", dir);
    let i = await read(file);
    expect(i.priority).toBe("p1");
    expect(i.waitingOn).toBe("external");
    await handleIssueUpdate("ISS-001", { waitingOn: "none" } as never, "json", dir);
    i = await read(file);
    expect("waitingOn" in i).toBe(false);
    expect(i.priority).toBe("p1");
  });

  it("create accepts --priority and --waiting-on", async () => {
    const { dir } = await setup();
    const result = await handleIssueCreate(
      { title: "Second", severity: "low", impact: "x", components: [], relatedTickets: [], location: [], priority: "p3", waitingOn: "owner" } as never,
      "json", dir,
    );
    const data = JSON.parse(result.output).data;
    expect(data.priority).toBe("p3");
    expect(data.waitingOn).toBe("owner");
  });

  it("--priority high and --waiting-on maybe are refused and nothing is written", async () => {
    const { dir, file } = await setup();
    const before = await readFile(file, "utf-8");
    await expect(handleIssueUpdate("ISS-001", { priority: "high" } as never, "json", dir)).rejects.toThrow(/p0, p1, p2, p3/);
    await expect(handleIssueUpdate("ISS-001", { waitingOn: "maybe" } as never, "json", dir)).rejects.toThrow(/owner, external, none/);
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  it("list --priority p2 includes an issue with no priority; --waiting-on filters through the view", () => {
    const ctx = makeCtx({
      state: makeState({
        issues: [
          makeIssue({ id: "ISS-001" }),
          makeIssue({ id: "ISS-002", priority: "p1" } as never),
          makeIssue({ id: "ISS-003", priority: "high", waitingOn: "external" } as never),
        ],
      }),
    });
    const p2 = handleIssueList({ priority: "p2" } as never, ctx).output;
    expect(p2).toContain("ISS-001");
    expect(p2).toContain("ISS-003");
    expect(p2).not.toContain("ISS-002");
    const ext = handleIssueList({ waitingOn: "external" } as never, ctx).output;
    expect(ext).toContain("ISS-003");
    expect(ext).not.toContain("ISS-001");
  });

  it("meta set priority and waitingOn refuse, naming the flag", async () => {
    const { dir, file } = await setup();
    const before = await readFile(file, "utf-8");
    await expect(handleIssueMetaSet("ISS-001", "priority", "p1", "json", dir)).rejects.toThrow(/--priority/);
    await expect(handleIssueMetaSet("ISS-001", "waitingOn", "owner", "json", dir)).rejects.toThrow(/--waiting-on/);
    expect(await readFile(file, "utf-8")).toBe(before);
  });
});
