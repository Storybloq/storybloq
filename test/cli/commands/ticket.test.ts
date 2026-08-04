import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTicketList,
  handleTicketGet,
  handleTicketNext,
  handleTicketBlocked,
  handleTicketCreate,
  handleTicketUpdate,
  handleTicketMetaGet,
  handleTicketMetaSet,
  handleTicketMetaUnset,
  handleTicketDelete,
  handleTicketStart,
} from "../../../src/cli/commands/ticket.js";
import { execFileSync } from "node:child_process";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { makeState, makeTicket, makeRoadmap, makePhase } from "../../core/test-factories.js";
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

describe("handleTicketList", () => {
  it("returns all leaf tickets with no filters", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", title: "First" }),
          makeTicket({ id: "T-002", phase: "p1", title: "Second" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketList({}, ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).toContain("T-002");
  });

  it("filters by status", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "open" }),
          makeTicket({ id: "T-002", phase: "p1", status: "complete" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketList({ status: "open" }, ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).not.toContain("T-002");
  });

  it("filters by phase", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1" }),
          makeTicket({ id: "T-002", phase: "p2" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
      }),
    });
    const result = handleTicketList({ phase: "p1" }, ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).not.toContain("T-002");
  });

  it("filters by type", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", type: "task" }),
          makeTicket({ id: "T-002", phase: "p1", type: "chore" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketList({ type: "task" }, ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).not.toContain("T-002");
  });

  it("filters with multiple criteria", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "open", type: "task" }),
          makeTicket({ id: "T-002", phase: "p1", status: "complete", type: "task" }),
          makeTicket({ id: "T-003", phase: "p2", status: "open", type: "task" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
      }),
    });
    const result = handleTicketList({ status: "open", phase: "p1" }, ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).not.toContain("T-002");
    expect(result.output).not.toContain("T-003");
  });

  it("throws on invalid status filter", () => {
    const ctx = makeCtx();
    expect(() => handleTicketList({ status: "invalid" }, ctx)).toThrow(
      CliValidationError,
    );
  });

  it("throws on invalid type filter", () => {
    const ctx = makeCtx();
    expect(() => handleTicketList({ type: "invalid" }, ctx)).toThrow(
      CliValidationError,
    );
  });
});

describe("handleTicketGet", () => {
  it("returns ticket when found", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", title: "My Ticket" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketGet("T-001", ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).toContain("My Ticket");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns not_found when missing", () => {
    const ctx = makeCtx();
    const result = handleTicketGet("T-999", ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });

  it("returns umbrella tickets", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", title: "Umbrella" }),
          makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    // T-001 is an umbrella (has children), but get should still return it
    const result = handleTicketGet("T-001", ctx);
    expect(result.output).toContain("Umbrella");
  });
});

describe("handleTicketNext", () => {
  it("returns found ticket with exit 0", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketNext(ctx);
    expect(result.output).toContain("T-001");
    expect(result.exitCode).toBe(ExitCode.OK);
  });

  it("returns exit 1 when all blocked", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "open", blockedBy: ["T-999"] }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketNext(ctx);
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });
});

describe("handleTicketBlocked", () => {
  it("returns blocked tickets", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "open" }),
          makeTicket({ id: "T-002", phase: "p1", status: "open", blockedBy: ["T-999"] }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleTicketBlocked(ctx);
    expect(result.output).toContain("T-002");
    expect(result.exitCode).toBeUndefined();
  });
});

// --- Write Handler Tests ---

describe("handleTicketCreate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("creates a ticket and writes to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleTicketCreate(
      { title: "New Ticket", type: "task", phase: "p0", description: "desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    expect(result.output).toContain("Created ticket T-001");
    const raw = await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8");
    const ticket = JSON.parse(raw);
    expect(ticket.title).toBe("New Ticket");
    expect(ticket.status).toBe("open");
  });

  it("creates canonical IDs with display IDs in explicit team mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await enableTeamMode(dir);

    const result = await handleTicketCreate(
      { title: "Team Ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json", dir,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.data.id).toMatch(/^t-[a-z0-9]{16}$/);
    expect(parsed.data.displayId).toBe("T-001");
    expect(parsed.data.createdAt).toEqual(expect.any(String));
    const raw = await readFile(join(dir, ".story", "tickets", `${parsed.data.id}.json`), "utf-8");
    const ticket = JSON.parse(raw);
    expect(ticket.title).toBe("Team Ticket");
    await expect(readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8")).rejects.toThrow();
  });

  it("auto-allocates sequential IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "First", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const result = await handleTicketCreate(
      { title: "Second", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    expect(result.output).toContain("T-002");
  });

  it("returns valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleTicketCreate(
      { title: "Test", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.id).toBe("T-001");
  });

  it("rejects invalid type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleTicketCreate(
        { title: "Test", type: "invalid", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md", dir,
      ),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects nonexistent phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleTicketCreate(
        { title: "Test", type: "task", phase: "nonexistent", description: "", blockedBy: [], parentTicket: null },
        "md", dir,
      ),
    ).rejects.toThrow("not found in roadmap");
  });

  it("sets createdDate to today", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleTicketCreate(
      { title: "Test", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("handleTicketUpdate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupProject(dir: string) {
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
  }

  it("updates title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    const result = await handleTicketUpdate("T-001", { title: "Updated" }, "md", dir);
    expect(result.output).toContain("Updated ticket T-001: Updated");
  });

  it("status→complete sets completedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    const result = await handleTicketUpdate("T-001", { status: "complete" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("complete");
    expect(parsed.data.completedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("complete→open clears completedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    await handleTicketUpdate("T-001", { status: "complete" }, "md", dir);
    const result = await handleTicketUpdate("T-001", { status: "open" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.completedDate).toBeNull();
  });

  it("complete→complete preserves completedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    await handleTicketUpdate("T-001", { status: "complete" }, "md", dir);
    const result = await handleTicketUpdate("T-001", { title: "Renamed" }, "json", dir);
    const parsed = JSON.parse(result.output);
    // Status not changed, so date should be preserved
    expect(parsed.data.completedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("status→complete clears claim and claimedBySession on disk (G-6)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    const ticketPath = join(dir, ".story", "tickets", "T-001.json");
    const raw = JSON.parse(await readFile(ticketPath, "utf-8"));
    raw.claim = { user: "alice@test.com", branch: "feat/x", since: "2026-05-26T10:00:00Z" };
    raw.claimedBySession = "sess-abc";
    await writeFile(ticketPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    // T-442: the fixture has no git identity, so ownership of alice@test.com's
    // claim cannot be proven and the completion is now refused rather than
    // silently taking the ticket from whoever holds it. Real single-user projects
    // are unaffected -- the claim's user comes from gitUserEmail at claim time, so
    // it matches. `--force` is the documented administrative bypass.
    await expect(
      handleTicketUpdate("T-001", { status: "complete" }, "json", dir),
    ).rejects.toThrow(/cannot prove ownership/);

    const untouched = JSON.parse(await readFile(ticketPath, "utf-8"));
    expect(untouched.status).toBe("open");
    expect(untouched.claim).toBeDefined();

    await handleTicketUpdate("T-001", { status: "complete" }, "json", dir, true);

    const disk = JSON.parse(await readFile(ticketPath, "utf-8"));
    expect(disk.status).toBe("complete");
    expect(disk.claim).toBeUndefined();
    expect(disk.claimedBySession).toBeUndefined();
  });

  it("returns not_found for missing ticket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleTicketUpdate("T-999", { title: "X" }, "md", dir),
    ).rejects.toThrow("not found");
  });

  it("--phase '' clears phase to null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    const result = await handleTicketUpdate("T-001", { phase: null }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.phase).toBeNull();
  });

  it("replaces blockedBy array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    // Create T-002 to use as blocker
    await handleTicketCreate(
      { title: "Blocker", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const result = await handleTicketUpdate("T-001", { blockedBy: ["T-002"] }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.blockedBy).toEqual(["T-002"]);
  });

  it("preserves passthrough fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    // Write a ticket with an extra field
    const raw = await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8");
    const ticket = JSON.parse(raw);
    ticket.customField = "preserved";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(dir, ".story", "tickets", "T-001.json"), JSON.stringify(ticket, null, 2));
    // Update title -- should preserve customField
    const result = await handleTicketUpdate("T-001", { title: "New Title" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.customField).toBe("preserved");
  });

  it("updates type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    const result = await handleTicketUpdate("T-001", { type: "feature" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.type).toBe("feature");
  });

  it("rejects invalid type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    await expect(
      handleTicketUpdate("T-001", { type: "invalid" }, "md", dir),
    ).rejects.toThrow("Unknown ticket type");
  });
});

describe("handleTicketMeta", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupProject(dir: string) {
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
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

  it("sets and gets custom metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    const setResult = await handleTicketMetaSet("T-001", "labels", ["frontend", "qa"], "json", dir);
    expect(JSON.parse(setResult.output).data.labels).toEqual(["frontend", "qa"]);

    const getResult = handleTicketMetaGet("T-001", "labels", await loadCtx(dir));
    expect(JSON.parse(getResult.output).data).toEqual(["frontend", "qa"]);
  });

  it("sets nested custom metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await handleTicketMetaSet("T-001", "integrations.linearIssue", "ABC-123", "json", dir);
    const getResult = handleTicketMetaGet("T-001", "integrations", await loadCtx(dir));
    expect(JSON.parse(getResult.output).data).toEqual({ linearIssue: "ABC-123" });
  });

  it("returns all custom metadata without core fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await handleTicketMetaSet("T-001", "priority", "high", "json", dir);
    const getResult = handleTicketMetaGet("T-001", undefined, await loadCtx(dir));
    const metadata = JSON.parse(getResult.output).data;
    expect(metadata).toEqual({ priority: "high" });
    expect(metadata.title).toBeUndefined();
    expect(metadata.status).toBeUndefined();
  });

  it("unsets custom metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await handleTicketMetaSet("T-001", "integrations.linearIssue", "ABC-123", "json", dir);
    const unsetResult = await handleTicketMetaUnset("T-001", "integrations.linearIssue", "json", dir);
    expect(JSON.parse(unsetResult.output).data.integrations).toEqual({});
  });

  it("rejects protected core fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await expect(
      handleTicketMetaSet("T-001", "status", "complete", "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects team-mode protected field displayId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await expect(
      handleTicketMetaSet("T-001", "displayId", "T-999", "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects team-mode protected field _conflicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await expect(
      handleTicketMetaSet("T-001", "_conflicts", [], "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects team-mode protected field claim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await expect(
      handleTicketMetaSet("T-001", "claim", { user: "x" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects team-mode protected field lifecycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    await expect(
      handleTicketMetaSet("T-001", "lifecycle", "deleted", "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("returns not_found for missing metadata path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-meta-"));
    tmpDirs.push(dir);
    await setupProject(dir);

    const result = handleTicketMetaGet("T-001", "missing", await loadCtx(dir));
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    expect(result.output).toContain("not_found");
  });
});

describe("handleTicketDelete", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("deletes a ticket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Doomed", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const result = await handleTicketDelete("T-001", false, "md", dir);
    expect(result.output).toContain("Deleted ticket T-001");
  });

  it("--force bypasses ref checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Blocker", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await handleTicketCreate(
      { title: "Blocked", type: "task", phase: "p0", description: "", blockedBy: ["T-001"], parentTicket: null },
      "md", dir,
    );
    // Normal delete would fail (T-002 references T-001)
    const result = await handleTicketDelete("T-001", true, "md", dir);
    expect(result.output).toContain("Deleted ticket T-001");
  });

  it("returns JSON envelope for delete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Test", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const result = await handleTicketDelete("T-001", false, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.deleted).toBe(true);
  });
});

describe("handleTicketStart claim semantics (ISS-680)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // Sets up a temp project with a git identity (so handleTicketStart can read
  // user.email) and a T-001 claimed by `claimUser`.
  async function setup(myEmail: string, claimUser: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ticket-start-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", myEmail], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    await handleTicketCreate(
      { title: "Claimed", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const path = join(dir, ".story", "tickets", "T-001.json");
    const ticket = JSON.parse(await readFile(path, "utf-8"));
    ticket.claim = { user: claimUser, branch: "feature/theirs", since: "2026-05-26T00:00:00Z" };
    await writeFile(path, JSON.stringify(ticket, null, 2) + "\n", "utf-8");
    return dir;
  }

  it("warns and proceeds (takes over) on a foreign claim instead of throwing", async () => {
    const dir = await setup("alice@example.com", "bob@example.com");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // Must NOT throw -- claims are advisory (N-059 #22).
      const result = await handleTicketStart("T-001", "json", dir);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.status).toBe("inprogress");
      expect(parsed.data.claim.user).toBe("alice@example.com"); // claim taken over (latest-wins)
      const warned = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain("claimed by bob@example.com");
    } finally {
      stderr.mockRestore();
    }
  });

  it("--force takes over a foreign claim without emitting a warning", async () => {
    const dir = await setup("alice@example.com", "bob@example.com");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const result = await handleTicketStart("T-001", "json", dir, true);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.status).toBe("inprogress");
      expect(parsed.data.claim.user).toBe("alice@example.com");
      const warned = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).not.toContain("claimed by");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("global _conflicts write-block through CLI handlers (ISS-695)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function seedConflict(dir: string, ticketId: string) {
    const path = join(dir, ".story", "tickets", `${ticketId}.json`);
    const raw = JSON.parse(await readFile(path, "utf-8"));
    raw._conflicts = [
      { fieldPath: "/title", field: "title", kind: "field", base: "Original", ours: "Ours", theirs: "Theirs" },
    ];
    await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  }

  // The spec requires rejecting ALL mutating writes while ANY .story/ item has
  // _conflicts. The gate (assertNoConflictsFromDisk) is wired into the write path;
  // these exercise it end-to-end through real CLI handlers on a different, clean item.
  it("blocks updating a clean ticket while another ticket has _conflicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conflict-block-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate({ title: "Conflicted", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", dir);
    await handleTicketCreate({ title: "Clean", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", dir);
    await seedConflict(dir, "T-001");

    await expect(
      handleTicketUpdate("T-002", { title: "Should be refused" }, "md", dir),
    ).rejects.toThrow(/unresolved conflicts/i);
  });

  it("blocks creating a new ticket while another item has _conflicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conflict-block-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate({ title: "Conflicted", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", dir);
    await seedConflict(dir, "T-001");

    await expect(
      handleTicketCreate({ title: "New", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", dir),
    ).rejects.toThrow(/unresolved conflicts/i);
  });
});
