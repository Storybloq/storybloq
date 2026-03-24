import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleIssueList,
  handleIssueGet,
  handleIssueCreate,
  handleIssueUpdate,
  handleIssueDelete,
} from "../../../src/cli/commands/issue.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
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
