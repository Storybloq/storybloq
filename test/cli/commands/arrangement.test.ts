import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleArrangementList,
  handleArrangementGet,
  handleArrangementCreate,
  handleArrangementUpdate,
} from "../../../src/cli/commands/arrangement.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { handleIssueCreate } from "../../../src/cli/commands/issue.js";
import { handleEarmarkReserve } from "../../../src/cli/commands/earmark.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";

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

const PARTIES = [
  { role: "pen" as const, client: "claude" as const, identityAnchor: "pen-session" },
  { role: "worker" as const, client: "claude" as const, identityAnchor: "worker-session" },
];

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProjectWithTicket(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "arrangement-cli-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  await handleTicketCreate(
    { title: "Duet arrangement ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    dir,
  );
  return { dir };
}

/** Writes a post-migration, canonical-id-only ticket file directly to disk. */
function writeCanonicalTicket(dir: string, id: string): void {
  writeFileSync(
    join(dir, ".story", "tickets", `${id}.json`),
    JSON.stringify({
      id,
      title: `Canonical ticket ${id}`,
      type: "task",
      status: "open",
      phase: "p0",
      order: 20,
      description: "",
      createdDate: "2026-08-27",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    }),
  );
}

/** Writes a post-migration, canonical-id issue with a paired legacy displayId. */
function writeCanonicalIssue(dir: string, id: string, displayId: string): void {
  writeFileSync(
    join(dir, ".story", "issues", `${id}.json`),
    JSON.stringify({
      id,
      displayId,
      title: `Canonical issue ${displayId}`,
      status: "open",
      severity: "medium",
      components: [],
      impact: "test",
      resolution: null,
      location: [],
      discoveredDate: "2026-08-27",
      createdAt: "2026-08-27T00:00:00.000Z",
      resolvedDate: null,
      relatedTickets: [],
      phase: null,
    }),
  );
}

describe("handleArrangementCreate", () => {
  it("creates an arrangement with a display-form bound ref and writes it to disk", async () => {
    const { dir } = await newProjectWithTicket();
    const result = await handleArrangementCreate(
      { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "md",
      dir,
    );
    expect(result.output).toContain("a-");
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, ".story", "arrangements")));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(dir, ".story", "arrangements", files[0]!), "utf-8");
    const arrangement = JSON.parse(raw);
    expect(arrangement.bounds).toEqual(["T-001"]);
    expect(arrangement.lifecycle).toBe("active");
    expect(arrangement.unreachability.onIrreversibleWork).toBe("hold");
  });

  it("rejects an empty bounds array", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(
      handleArrangementCreate({ bounds: [], parties: PARTIES, onIrreversibleWork: "hold" }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects a bounds ref that does not resolve to any ticket or issue", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(
      handleArrangementCreate({ bounds: ["T-999"], parties: PARTIES, onIrreversibleWork: "hold" }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects a bounds ref that is neither a ticket nor an issue shape", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(
      handleArrangementCreate({ bounds: ["N-001"], parties: PARTIES, onIrreversibleWork: "hold" }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("resolves a canonical (t-[canonical]) ticket bound ref to that ticket's own canonical id (binding item 1)", async () => {
    const { dir } = await newProjectWithTicket();
    const canonicalId = "t-0123456789abcdef";
    writeCanonicalTicket(dir, canonicalId);
    const result = await handleArrangementCreate(
      { bounds: [canonicalId], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    expect(JSON.parse(result.output).data.bounds).toEqual([canonicalId]);
  });

  it("resolves a canonical (i-[canonical]) issue bound ref to that issue's own canonical id (binding item 1)", async () => {
    const { dir } = await newProjectWithTicket();
    const canonicalId = "i-fedcba9876543210";
    writeCanonicalIssue(dir, canonicalId, "ISS-501");
    const result = await handleArrangementCreate(
      { bounds: [canonicalId], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    expect(JSON.parse(result.output).data.bounds).toEqual([canonicalId]);
  });

  it("resolves a migrated issue addressed by its legacy display id to the same canonical id (binding item 1)", async () => {
    const { dir } = await newProjectWithTicket();
    const canonicalId = "i-fedcba9876543210";
    writeCanonicalIssue(dir, canonicalId, "ISS-501");
    const result = await handleArrangementCreate(
      { bounds: ["ISS-501"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    expect(JSON.parse(result.output).data.bounds).toEqual([canonicalId]);
  });

  it("rejects a party topology violating exactly-one-pen-one-worker (schema invariant surfaces as invalid_input)", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(
      handleArrangementCreate(
        {
          bounds: ["T-001"],
          parties: [
            { role: "worker" as const, client: "claude" as const, identityAnchor: "a" },
            { role: "worker" as const, client: "claude" as const, identityAnchor: "b" },
          ],
          onIrreversibleWork: "hold",
        },
        "md",
        dir,
      ),
    ).rejects.toThrow(CliValidationError);
  });
});

describe("handleArrangementGet / handleArrangementList", () => {
  it("gets a created arrangement by its canonical id", async () => {
    const { dir } = await newProjectWithTicket();
    const created = await handleArrangementCreate(
      { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    const result = handleArrangementGet(id, makeCtx({ root: dir }));
    expect(result.output).toContain(id);
  });

  it("returns not_found for a missing arrangement", async () => {
    const { dir } = await newProjectWithTicket();
    const result = handleArrangementGet("a-0000000000000000", makeCtx({ root: dir }));
    expect(result.errorCode).toBe("not_found");
  });

  it("lists created arrangements and filters by lifecycle", async () => {
    const { dir } = await newProjectWithTicket();
    const created = await handleArrangementCreate(
      { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    const activeList = handleArrangementList({ lifecycle: "active" }, makeCtx({ root: dir }));
    expect(activeList.output).toContain(id);
    const closedList = handleArrangementList({ lifecycle: "closed" }, makeCtx({ root: dir }));
    expect(closedList.output).not.toContain(id);
  });
});

describe("handleArrangementUpdate", () => {
  it("updates lifecycle via the ordinary atomic-replace path (binding item 3)", async () => {
    const { dir } = await newProjectWithTicket();
    const created = await handleArrangementCreate(
      { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    const result = await handleArrangementUpdate(id, { lifecycle: "closed" }, "json", dir);
    expect(JSON.parse(result.output).data.lifecycle).toBe("closed");
    const raw = await readFile(join(dir, ".story", "arrangements", `${id}.json`), "utf-8");
    expect(JSON.parse(raw).lifecycle).toBe("closed");
  });

  it("rejects update with no lifecycle field", async () => {
    const { dir } = await newProjectWithTicket();
    const created = await handleArrangementCreate(
      { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    await expect(handleArrangementUpdate(id, {}, "md", dir)).rejects.toThrow(CliValidationError);
  });

  it("rejects an unknown lifecycle value", async () => {
    const { dir } = await newProjectWithTicket();
    const created = await handleArrangementCreate(
      { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    await expect(handleArrangementUpdate(id, { lifecycle: "archived" }, "md", dir)).rejects.toThrow(CliValidationError);
  });

  it("rejects updating a nonexistent arrangement", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(
      handleArrangementUpdate("a-0000000000000000", { lifecycle: "closed" }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  describe("T-475 section 5: closing an arrangement retracts every earmark it authorized", () => {
    it("clears a reserved ticket earmark and an assigned issue earmark bound to the closing arrangement, in one locked write (lock-nesting regression)", async () => {
      const { dir } = await newProjectWithTicket();
      const issueCreated = await handleIssueCreate(
        { title: "Duet arrangement issue", severity: "medium", impact: "", components: [], relatedTickets: [], location: [] },
        "json",
        dir,
      );
      const issueId = JSON.parse(issueCreated.output).data.id as string;

      const created = await handleArrangementCreate(
        { bounds: ["T-001", issueId], parties: PARTIES, onIrreversibleWork: "hold" },
        "json",
        dir,
      );
      const arrangementId = JSON.parse(created.output).data.id as string;

      // If `clearEarmarkUnlocked` mistakenly opened its OWN `withProjectLock`
      // instead of running inside `handleArrangementUpdate`'s existing lock,
      // this call would deadlock and the test would time out rather than
      // fail an assertion -- that IS the regression this test guards.
      await handleEarmarkReserve(
        { ref: "T-001", role: "worker", arrangement: arrangementId, clientTaskId: "worker-session" },
        "json",
        dir,
      );

      // `earmark assign`'s "--to" requires a live, matching session to
      // resolve against, which this lock-nesting test has no need to stand
      // up -- write the assigned issue earmark directly instead, exercising
      // exactly what clearEarmarkUnlocked scans for on the issue side.
      const issuePath = join(dir, ".story", "issues", `${issueId}.json`);
      const issueRaw = JSON.parse(await readFile(issuePath, "utf-8"));
      writeFileSync(issuePath, JSON.stringify({
        ...issueRaw,
        earmark: {
          stage: "assigned",
          reservedBy: { client: "claude", id: "worker-session" },
          arrangementId,
          since: new Date().toISOString(),
          holderRole: "worker",
          holderSession: "11111111-1111-4111-8111-111111111111",
        },
      }, null, 2));

      const ticketBefore = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
      expect(ticketBefore.earmark).toBeTruthy();

      await handleArrangementUpdate(arrangementId, { lifecycle: "closed" }, "json", dir);

      const ticketAfter = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
      const issueAfter = JSON.parse(await readFile(issuePath, "utf-8"));
      expect(ticketAfter.earmark).toBeNull();
      expect(issueAfter.earmark).toBeNull();
    });

    it("does not clear an earmark bound to a DIFFERENT arrangement", async () => {
      const { dir } = await newProjectWithTicket();
      const closing = await handleArrangementCreate(
        { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
        "json",
        dir,
      );
      const closingId = JSON.parse(closing.output).data.id as string;

      await handleTicketCreate(
        { title: "Second ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md",
        dir,
      );
      const other = await handleArrangementCreate(
        { bounds: ["T-002"], parties: PARTIES, onIrreversibleWork: "hold" },
        "json",
        dir,
      );
      const otherId = JSON.parse(other.output).data.id as string;
      await handleEarmarkReserve(
        { ref: "T-002", role: "worker", arrangement: otherId, clientTaskId: "worker-session" },
        "json",
        dir,
      );

      await handleArrangementUpdate(closingId, { lifecycle: "closed" }, "json", dir);

      const otherTicket = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-002.json"), "utf-8"));
      expect(otherTicket.earmark).toBeTruthy();
      expect(otherTicket.earmark.arrangementId).toBe(otherId);
    });
  });
});
