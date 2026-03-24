import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTicketList,
  handleTicketGet,
  handleTicketNext,
  handleTicketBlocked,
  handleTicketCreate,
  handleTicketUpdate,
  handleTicketDelete,
} from "../../../src/cli/commands/ticket.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
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
    // Update title — should preserve customField
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
