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
    // ISS-981: reopening a completed ticket now requires proof or --force,
    // even claim-free (this fixture has none) -- the property this test
    // pins is the completedDate lifecycle, not authorization, so force it.
    const result = await handleTicketUpdate("T-001", { status: "open" }, "json", dir, true);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.completedDate).toBeNull();
  });

  it("complete→complete preserves completedDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-update-"));
    tmpDirs.push(dir);
    await setupProject(dir);
    await handleTicketUpdate("T-001", { status: "complete" }, "md", dir);
    // ISS-981: same as above -- this test pins date preservation, not
    // authorization.
    const result = await handleTicketUpdate("T-001", { title: "Renamed" }, "json", dir, true);
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

describe("guardCompletedTicketMutation guard (ISS-981)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // A temp project with a REPO-LOCAL git identity (so gitUserEmail resolves
  // deterministically regardless of the host's ambient git config) and a
  // T-001 that is COMPLETE and still carries claim material -- the ISS-913
  // "contradictory" shape. Completion normally strips claim keys on success;
  // this fixture reproduces the case where it didn't.
  async function setupCompletedClaimedTicket(myEmail: string, claimUser: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ticket-guard-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", myEmail], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const path = join(dir, ".story", "tickets", "T-001.json");
    const ticket = JSON.parse(await readFile(path, "utf-8"));
    ticket.status = "complete";
    ticket.completedDate = "2026-05-26";
    ticket.claim = { user: claimUser, branch: "feature/theirs", since: "2026-05-26T00:00:00Z" };
    await writeFile(path, JSON.stringify(ticket, null, 2) + "\n", "utf-8");
    return dir;
  }

  // The claim-FREE complete ticket: the shape a normal completion actually
  // leaves behind, since clearClaimOnComplete strips claim keys on success.
  // No claim, no claimedBySession, so nothing for the guard to authorize
  // against and no other party's ownership at stake.
  async function setupCompletedUnclaimedTicket(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ticket-guard-unclaimed-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "me@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const path = join(dir, ".story", "tickets", "T-001.json");
    const ticket = JSON.parse(await readFile(path, "utf-8"));
    ticket.status = "complete";
    ticket.completedDate = "2026-05-26";
    await writeFile(path, JSON.stringify(ticket, null, 2) + "\n", "utf-8");
    return dir;
  }

  // 1.9.0 scope: ISS-981 guards the REOPEN direction, which is the defect its
  // filing names ("reopens a completed ticket and erases its completion
  // date"). A metadata edit erases nothing and takes nothing from anyone, so
  // guarding it only broke a routine correction on finished work. These two
  // pin both halves of that boundary on the claim-free shape.

  it("[ISS-981 scope] allows a metadata edit on a claim-free complete ticket, preserving status and completedDate", async () => {
    const dir = await setupCompletedUnclaimedTicket();
    await handleTicketUpdate("T-001", { title: "Corrected" }, "json", dir);
    const after = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(after.title).toBe("Corrected");
    expect(after.status).toBe("complete"); // the edit must not reopen it
    expect(after.completedDate).toBe("2026-05-26"); // and must not erase the date
  });

  it("[ISS-981 scope] still refuses to REOPEN a claim-free complete ticket without --force", async () => {
    const dir = await setupCompletedUnclaimedTicket();
    await expect(
      handleTicketUpdate("T-001", { status: "open" }, "json", dir),
    ).rejects.toThrow(/Cannot reopen/);
    const after = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(after.status).toBe("complete");
    expect(after.completedDate).toBe("2026-05-26");
  });

  // test 1: RED-at-parent. Covers the missing-identity path specifically
  // (distinct from #4b's resolvable-but-mismatched identity): an explicit
  // repo-local `user.email ""` deterministically forces gitUserEmail to
  // resolve null, overriding whatever the host's global git config happens
  // to be -- relying on ambient config alone (as this test originally did)
  // would fail on a host whose global user.email happens to equal
  // "someone-else@test.com".
  it("[ISS-981 #1] refuses to reopen a complete ticket when ownership is unproven (no identity available)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-guard-noident-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", ""], { cwd: dir });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    const path = join(dir, ".story", "tickets", "T-001.json");
    const ticket = JSON.parse(await readFile(path, "utf-8"));
    ticket.status = "complete";
    ticket.completedDate = "2026-05-26";
    ticket.claim = { user: "someone-else@test.com", branch: "feature/theirs", since: "2026-05-26T00:00:00Z" };
    await writeFile(path, JSON.stringify(ticket, null, 2) + "\n", "utf-8");

    await expect(
      handleTicketUpdate("T-001", { status: "open" }, "json", dir),
    ).rejects.toThrow(/cannot prove ownership \(git user\.email is not configured\)/);

    const untouched = JSON.parse(await readFile(path, "utf-8"));
    expect(untouched.status).toBe("complete");
  });

  // test 2: disclosed NON-REGRESSION PIN, not RED-at-parent. Reproduced
  // empirically against the parent commit: the pre-existing, untouched
  // `clearClaimOnComplete(ticket, guard)` call already runs against the
  // merged candidate whenever the candidate's status stays "complete" (its
  // exemption is keyed on the CANDIDATE's target status, not on whether this
  // update transitions INTO complete), so a field-only mutation with a
  // contradictory claim already rejected at parent for that pre-existing,
  // unrelated reason. Kept as an explicit pin -- the case must remain
  // guarded post-fix, whichever mechanism does it -- not claimed as new
  // coverage from `guardCompletedTicketMutation` (see plan [IMPL-F1]).
  it("[ISS-981 #2, non-regression] refuses to change a field on a complete ticket when ownership is unproven", async () => {
    const dir = await setupCompletedClaimedTicket("me@test.com", "someone-else@test.com");
    await expect(
      handleTicketUpdate("T-001", { title: "Renamed" }, "json", dir),
    ).rejects.toThrow(/cannot prove ownership/);
    const path = join(dir, ".story", "tickets", "T-001.json");
    const untouched = JSON.parse(await readFile(path, "utf-8"));
    expect(untouched.title).toBe("Original");
  });

  // test 3: disclosed non-regression pin, paired with #1 -- --force is the
  // documented administrative bypass and must still work post-fix.
  it("[ISS-981 #3] --force reopens a complete ticket despite unproven ownership", async () => {
    const dir = await setupCompletedClaimedTicket("me@test.com", "someone-else@test.com");
    const result = await handleTicketUpdate("T-001", { status: "open" }, "json", dir, true);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("open");
  });

  // test 4: disclosed non-regression pin -- a caller whose git identity
  // genuinely matches the claim can still reopen without --force.
  it("[ISS-981 #4] reopens a complete ticket when the caller's git identity matches the claim", async () => {
    const dir = await setupCompletedClaimedTicket("me@test.com", "me@test.com");
    const result = await handleTicketUpdate("T-001", { status: "open" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("open");
  });

  // test 4b: RED-at-parent, and the one that actually proves the comparison
  // discriminates rather than merely gating on "no identity at all" -- a
  // repo-local, RESOLVABLE identity that simply does not match the claim.
  it("[ISS-981 #4b] refuses to reopen when the caller's resolvable git identity does not match the claim", async () => {
    const dir = await setupCompletedClaimedTicket("me@test.com", "someone-else@test.com");
    await expect(
      handleTicketUpdate("T-001", { status: "open" }, "json", dir),
    ).rejects.toThrow(/cannot prove ownership/);
    const path = join(dir, ".story", "tickets", "T-001.json");
    const untouched = JSON.parse(await readFile(path, "utf-8"));
    expect(untouched.status).toBe("complete");
  });

  // test 6: MCP boundary, RED-at-parent. Confirms an unproven reopen through
  // the actual registered tool -- not `handleTicketUpdate` called directly
  // -- is refused when `force` is omitted. `force` IS declared on the schema
  // (ISS-981's F1-BLOCKING correction, see test 10 below for the dedicated
  // schema-shape + force-actually-works coverage); this test's job is the
  // refusal path, not the schema shape. In-process via InMemoryTransport; no
  // build required (ISS-978).
  it("[ISS-981 #6] MCP boundary: refuses an unproven reopen through the real registered tool when force is omitted", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerAllTools } = await import("../../../src/mcp/tools.js");

    const dir = await setupCompletedClaimedTicket("me@test.com", "someone-else@test.com");

    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    registerAllTools(server, dir);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "storybloq_ticket_update",
        arguments: { id: "T-001", status: "open" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/cannot prove ownership/);

      const path = join(dir, ".story", "tickets", "T-001.json");
      const untouched = JSON.parse(await readFile(path, "utf-8"));
      expect(untouched.status).toBe("complete");
    } finally {
      await client.close();
      await server.close();
    }
  });

  // tests 7/8: RED-at-parent (plan [IMPL-F2]/[IMPL-F3]; verified by
  // git-stash A/B, not merely a claim-free non-regression pin as originally
  // planned). Deliberately reuse the CLAIM-BEARING/unproven fixture, not a
  // claim-free one -- a claim-free ticket is already authorized by
  // `clearClaimOnComplete`'s own legacy fallback regardless of any guard, so
  // it cannot demonstrate the no-op exemption doing anything (confirmed by
  // simulating Mutant C2 against a claim-free fixture: still succeeds).
  // Reproduced against the actual parent commit: BOTH tests throw there --
  // parent's single, unconditional `clearClaimOnComplete(ticket, guard)`
  // call has no no-op awareness at all and rejects a claim-bearing/unproven
  // resend regardless of whether anything is actually changing. Only the
  // fix -- gating BOTH the new guard call AND the pre-existing
  // `clearClaimOnComplete` call on `isNoOpUpdate` -- makes these succeed.
  it("[ISS-981 #7] resends status:complete on an unproven-but-unchanged complete ticket without --force", async () => {
    const dir = await setupCompletedClaimedTicket("me@test.com", "someone-else@test.com");
    const result = await handleTicketUpdate("T-001", { status: "complete" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("complete");
  });

  it("[ISS-981 #8] resends a field to its own current value on an unproven-but-unchanged complete ticket without --force", async () => {
    const dir = await setupCompletedClaimedTicket("me@test.com", "someone-else@test.com");
    const result = await handleTicketUpdate("T-001", { title: "Original" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.title).toBe("Original");
  });

  // test 9, RED-at-parent: THE headline scenario ISS-981 was filed for --
  // "no claim, no --force" reopening a claim-free completed ticket. This is
  // the test whose absence let a narrower (claim-scoped) polarity survive
  // seven plan-review rounds and two code-review rounds: guardCompletedTicketMutation
  // must NOT reuse clearClaimOnComplete's "nothing to authorize against ->
  // pass" fallback here, because a claim-free ticket is the ORDINARY
  // post-completion state (completion strips claim keys on success), not an
  // edge case. --force (test 3b below) remains the escape.
  it("[ISS-981 #9] refuses to reopen a claim-free complete ticket without --force", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-guard-claimfree-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await handleTicketUpdate("T-001", { status: "complete" }, "json", dir);
    await expect(
      handleTicketUpdate("T-001", { status: "open" }, "json", dir),
    ).rejects.toThrow(/cannot prove ownership/);
    const path = join(dir, ".story", "tickets", "T-001.json");
    const untouched = JSON.parse(await readFile(path, "utf-8"));
    expect(untouched.status).toBe("complete");
  });

  // test 3b, disclosed non-regression pin, paired with #9: --force remains
  // the documented escape for a claim-free ticket, which has no identity to
  // prove ownership against in the first place.
  it("[ISS-981 #3b] --force reopens a claim-free complete ticket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-guard-claimfree-force-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await handleTicketUpdate("T-001", { status: "complete" }, "json", dir);
    const result = await handleTicketUpdate("T-001", { status: "open" }, "json", dir, true);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("open");
  });

  // test 10, MCP boundary, RED-at-parent, F1-BLOCKING per the pen's ruling:
  // `force` must actually be declared on the registered tool's schema (it
  // was NOT, before this correction -- widening the guard without this would
  // have permanently locked every MCP caller, including the pen itself, out
  // of ever reopening or editing completed work, an ISS-988-shaped refusal
  // naming an escape the caller cannot reach) and must actually be threaded
  // into `handleTicketUpdate`. Proves both ends: schema-shape, and a real
  // call with `force: true` succeeding where the same call without it does
  // not -- not an in-process handler call (same standard as ISS-982's test 9).
  it("[ISS-981 #10] MCP boundary: force is declared on the schema and actually authorizes a claim-free reopen", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerAllTools } = await import("../../../src/mcp/tools.js");

    const dir = await mkdtemp(join(tmpdir(), "ticket-guard-mcp-force-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleTicketCreate(
      { title: "Original", type: "task", phase: "p0", description: "orig desc", blockedBy: [], parentTicket: null },
      "md", dir,
    );
    await handleTicketUpdate("T-001", { status: "complete" }, "json", dir);

    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    registerAllTools(server, dir);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const tools = await client.listTools();
      const updateTool = tools.tools.find((t) => t.name === "storybloq_ticket_update");
      expect(updateTool).toBeDefined();
      expect(Object.keys(updateTool!.inputSchema.properties ?? {})).toContain("force");

      const withoutForce = await client.callTool({
        name: "storybloq_ticket_update",
        arguments: { id: "T-001", status: "open" },
      });
      expect(withoutForce.isError).toBe(true);

      const withForce = await client.callTool({
        name: "storybloq_ticket_update",
        arguments: { id: "T-001", status: "open", force: true },
      });
      expect(withForce.isError).toBeUndefined();

      const path = join(dir, ".story", "tickets", "T-001.json");
      const disk = JSON.parse(await readFile(path, "utf-8"));
      expect(disk.status).toBe("open");
    } finally {
      await client.close();
      await server.close();
    }
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
