import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handlePhaseList,
  handlePhaseCurrent,
  handlePhaseTickets,
  handlePhaseCreate,
  handlePhaseRename,
  handlePhaseMove,
  handlePhaseDelete,
} from "../../../src/cli/commands/phase.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { handleIssueCreate } from "../../../src/cli/commands/issue.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
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

describe("handlePhaseList", () => {
  it("returns phase list in md", () => {
    const ctx = makeCtx({
      state: makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1", name: "Setup" })]),
      }),
    });
    const result = handlePhaseList(ctx);
    expect(result.output).toContain("Setup");
  });

  it("returns valid JSON", () => {
    const ctx = makeCtx({ format: "json" });
    const result = handlePhaseList(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });
});

describe("handlePhaseCurrent", () => {
  it("returns current phase when found", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
        roadmap: makeRoadmap([makePhase({ id: "p1", name: "Alpha" })]),
      }),
    });
    const result = handlePhaseCurrent(ctx);
    expect(result.output).toContain("Alpha");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns exit 0 when all phases complete", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handlePhaseCurrent(ctx);
    expect(result.output).toContain("All phases complete");
    expect(result.exitCode).toBeUndefined(); // default OK
  });

  it("returns exit 1 when no phases have tickets", () => {
    const ctx = makeCtx({
      state: makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handlePhaseCurrent(ctx);
    expect(result.output).toContain("No phases with tickets");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });

  it("returns valid JSON with reason field", () => {
    const ctx = makeCtx({
      format: "json",
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handlePhaseCurrent(ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.reason).toBe("all_complete");
  });
});

describe("handlePhaseTickets", () => {
  it("returns tickets for a phase", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", title: "First" }),
          makeTicket({ id: "T-002", phase: "p2", title: "Second" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
      }),
    });
    const result = handlePhaseTickets("p1", ctx);
    expect(result.output).toContain("T-001");
    expect(result.output).not.toContain("T-002");
  });

  it("returns empty message for phase with no tickets", () => {
    const ctx = makeCtx({
      state: makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handlePhaseTickets("p1", ctx);
    expect(result.output).toContain("No tickets");
  });
});

// --- Write Handler Tests ---

describe("handlePhaseCreate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("creates a phase after existing phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handlePhaseCreate(
      { id: "p1", name: "Phase 1", label: "PHASE 1", description: "First phase", after: "p0", atStart: false },
      "md", dir,
    );
    expect(result.output).toContain("Created phase p1: Phase 1");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases).toHaveLength(2);
    expect(roadmap.phases[1].id).toBe("p1");
  });

  it("creates a phase at start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handlePhaseCreate(
      { id: "p-first", name: "First", label: "FIRST", description: "At start", atStart: true },
      "md", dir,
    );
    expect(result.output).toContain("Created phase p-first");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases[0].id).toBe("p-first");
    expect(roadmap.phases[1].id).toBe("p0");
  });

  it("rejects duplicate phase ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handlePhaseCreate(
        { id: "p0", name: "Dup", label: "DUP", description: "Dup", after: "p0", atStart: false },
        "md", dir,
      ),
    ).rejects.toThrow("already exists");
  });

  it("rejects invalid slug format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handlePhaseCreate(
        { id: "UPPER_CASE", name: "Bad", label: "BAD", description: "Bad", after: "p0", atStart: false },
        "md", dir,
      ),
    ).rejects.toThrow("lowercase alphanumeric");
  });

  it("rejects nonexistent --after target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handlePhaseCreate(
        { id: "p1", name: "Test", label: "T", description: "T", after: "nonexistent", atStart: false },
        "md", dir,
      ),
    ).rejects.toThrow("not found");
  });

  it("rejects both --after and --at-start", async () => {
    await expect(
      handlePhaseCreate(
        { id: "p1", name: "Test", label: "T", description: "T", after: "p0", atStart: true },
        "md", "/tmp/test",
      ),
    ).rejects.toThrow("Cannot use both");
  });

  it("rejects neither --after nor --at-start", async () => {
    await expect(
      handlePhaseCreate(
        { id: "p1", name: "Test", label: "T", description: "T", atStart: false },
        "md", "/tmp/test",
      ),
    ).rejects.toThrow("Must specify either");
  });

  it("returns valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handlePhaseCreate(
      { id: "p1", name: "Test", label: "TEST", description: "Test", after: "p0", atStart: false },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.id).toBe("p1");
  });

  it("includes summary when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handlePhaseCreate(
      { id: "p1", name: "Test", label: "TEST", description: "Full desc", summary: "Short", after: "p0", atStart: false },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.summary).toBe("Short");
  });
});

describe("handlePhaseRename", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("updates phase name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-rename-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handlePhaseRename("p0", { name: "Renamed" }, "md", dir);
    expect(result.output).toContain("Updated phase p0: Renamed");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases[0].name).toBe("Renamed");
  });

  it("returns not_found for missing phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-rename-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handlePhaseRename("nonexistent", { name: "X" }, "md", dir),
    ).rejects.toThrow("not found");
  });

  it("partial update preserves other fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-rename-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handlePhaseRename("p0", { label: "RENAMED" }, "json", dir);
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases[0].label).toBe("RENAMED");
    expect(roadmap.phases[0].name).toBe("Setup"); // preserved from init
  });
});

describe("handlePhaseMove", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("moves a phase after another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-move-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    // Create p1 and p2 after p0
    await handlePhaseCreate(
      { id: "p1", name: "Phase 1", label: "P1", description: "D1", after: "p0", atStart: false },
      "md", dir,
    );
    await handlePhaseCreate(
      { id: "p2", name: "Phase 2", label: "P2", description: "D2", after: "p1", atStart: false },
      "md", dir,
    );
    // Move p0 after p2 (to the end)
    const result = await handlePhaseMove("p0", { after: "p2", atStart: false }, "md", dir);
    expect(result.output).toContain("Moved phase p0");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases.map((p: { id: string }) => p.id)).toEqual(["p1", "p2", "p0"]);
  });

  it("moves a phase to start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-move-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handlePhaseCreate(
      { id: "p1", name: "Phase 1", label: "P1", description: "D1", after: "p0", atStart: false },
      "md", dir,
    );
    // Move p1 to start
    const result = await handlePhaseMove("p1", { atStart: true }, "md", dir);
    expect(result.output).toContain("Moved phase p1");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases[0].id).toBe("p1");
    expect(roadmap.phases[1].id).toBe("p0");
  });

  it("returns not_found for missing phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-move-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handlePhaseMove("nonexistent", { after: "p0", atStart: false }, "md", dir),
    ).rejects.toThrow("not found");
  });
});

describe("handlePhaseDelete", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("deletes an empty phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handlePhaseCreate(
      { id: "p1", name: "Empty", label: "E", description: "E", after: "p0", atStart: false },
      "md", dir,
    );
    const result = await handlePhaseDelete("p1", undefined, "md", dir);
    expect(result.output).toContain("Deleted phase p1");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases).toHaveLength(1);
    expect(roadmap.phases[0].id).toBe("p0");
  });

  it("refuses to delete phase with tickets when no --reassign", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await expect(
      handlePhaseDelete("p0", undefined, "md", dir),
    ).rejects.toThrow("1 ticket(s) reference it");
  });

  it("reassigns tickets and issues to target phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handlePhaseCreate(
      { id: "p1", name: "Target", label: "T", description: "T", after: "p0", atStart: false },
      "md", dir,
    );
    // Create ticket in p0
    await handleTicketCreate(
      { title: "T in p0", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    // Create issue in p0
    await handleIssueCreate(
      { title: "I in p0", severity: "medium", impact: "test", components: [], relatedTickets: ["T-001"], location: [] },
      "md", dir,
    );
    // Manually set issue phase to p0 (issue create doesn't set phase)
    const issuePath = join(dir, ".story", "issues", "ISS-001.json");
    const issueRaw = await readFile(issuePath, "utf-8");
    const issueData = JSON.parse(issueRaw);
    issueData.phase = "p0";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(issuePath, JSON.stringify(issueData, null, 2));

    const result = await handlePhaseDelete("p0", "p1", "md", dir);
    expect(result.output).toContain("Deleted phase p0");

    // Verify ticket reassigned
    const ticketRaw = await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8");
    const ticket = JSON.parse(ticketRaw);
    expect(ticket.phase).toBe("p1");

    // Verify issue reassigned
    const issueRaw2 = await readFile(issuePath, "utf-8");
    const issue = JSON.parse(issueRaw2);
    expect(issue.phase).toBe("p1");

    // Verify phase removed from roadmap
    const roadmapRaw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(roadmapRaw);
    expect(roadmap.phases).toHaveLength(1);
    expect(roadmap.phases[0].id).toBe("p1");
  });

  it("recomputes order for reassigned tickets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handlePhaseCreate(
      { id: "p1", name: "Target", label: "T", description: "T", after: "p0", atStart: false },
      "md", dir,
    );
    // Create ticket in target phase (p1) -- gets order 10
    await handleTicketCreate(
      { title: "Existing in p1", type: "task", phase: "p1", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    // Create two tickets in p0 -- get order 10, 20
    await handleTicketCreate(
      { title: "First in p0", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await handleTicketCreate(
      { title: "Second in p0", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    // Delete p0 with reassign to p1
    await handlePhaseDelete("p0", "p1", "md", dir);
    // Verify order: T-001 is in p1 with order 10. Reassigned should be after that.
    const t2 = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-002.json"), "utf-8"));
    const t3 = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-003.json"), "utf-8"));
    expect(t2.phase).toBe("p1");
    expect(t3.phase).toBe("p1");
    expect(t2.order).toBe(20); // 10 (max in p1) + 10
    expect(t3.order).toBe(30); // 10 (max in p1) + 20
  });

  it("rejects --reassign targeting nonexistent phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await expect(
      handlePhaseDelete("p0", "nonexistent", "md", dir),
    ).rejects.toThrow("not found");
  });

  it("rejects --reassign targeting self", async () => {
    await expect(
      handlePhaseDelete("p0", "p0", "md", "/tmp/test"),
    ).rejects.toThrow("Cannot reassign to the phase being deleted");
  });

  it("returns not_found for missing phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handlePhaseDelete("nonexistent", undefined, "md", dir),
    ).rejects.toThrow("not found");
  });

  it("returns valid JSON for delete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phase-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handlePhaseCreate(
      { id: "p1", name: "Empty", label: "E", description: "E", after: "p0", atStart: false },
      "md", dir,
    );
    const result = await handlePhaseDelete("p1", undefined, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.deleted).toBe(true);
    expect(parsed.data.id).toBe("p1");
  });
});
