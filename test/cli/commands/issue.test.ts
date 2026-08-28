import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
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
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { makeState, makeIssue } from "../../core/test-factories.js";
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
