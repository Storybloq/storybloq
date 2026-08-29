import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleReconcile } from "../../../src/cli/commands/reconcile.js";
import { ExitCode } from "../../../src/core/output-formatter.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "story-reconcile-"));
  const story = join(root, ".story");
  mkdirSync(join(story, "tickets"), { recursive: true });
  mkdirSync(join(story, "notes"), { recursive: true });
  writeJson(join(story, "config.json"), {
    version: 2,
    schemaVersion: 2,
    project: "test",
    type: "app",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    team: { enabled: true },
  });
  writeJson(join(story, "roadmap.json"), {
    title: "Test",
    date: "2026-05-26",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }],
    blockers: [],
  });
  return root;
}

describe("handleReconcile", () => {
  it("renumbers display IDs without rewriting cross-reference fields", async () => {
    const root = createProject();
    const tickets = join(root, ".story", "tickets");
    writeJson(join(tickets, "t-0000000000000001.json"), {
      id: "t-0000000000000001",
      displayId: "T-001",
      title: "Winner",
      type: "task",
      status: "open",
      phase: "p1",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    });
    writeJson(join(tickets, "t-0000000000000002.json"), {
      id: "t-0000000000000002",
      displayId: "T-001",
      title: "Loser",
      type: "task",
      status: "open",
      phase: "p1",
      order: 20,
      description: "",
      createdDate: "2026-02-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    });
    writeJson(join(tickets, "t-0000000000000003.json"), {
      id: "t-0000000000000003",
      displayId: "T-002",
      title: "Dependent",
      type: "task",
      status: "open",
      phase: "p1",
      order: 30,
      description: "",
      createdDate: "2026-02-02",
      completedDate: null,
      blockedBy: ["T-001"],
      parentTicket: "T-001",
    });

    const result = await handleReconcile(root, { dryRun: false, ci: false, format: "md" });

    expect(result.exitCode).toBe(0);
    const loser = JSON.parse(readFileSync(join(tickets, "t-0000000000000002.json"), "utf-8"));
    const dependent = JSON.parse(readFileSync(join(tickets, "t-0000000000000003.json"), "utf-8"));
    expect(loser.displayId).toBe("T-003");
    expect(loser.previousDisplayIds).toEqual(["T-001"]);
    expect(dependent.blockedBy).toEqual(["T-001"]);
    expect(dependent.parentTicket).toBe("T-001");
  });

  it("rebalances ranks even when display IDs are clean", async () => {
    const root = createProject();
    const tickets = join(root, ".story", "tickets");
    const longRank = "V".repeat(20);
    writeJson(join(tickets, "t-0000000000000001.json"), {
      id: "t-0000000000000001",
      displayId: "T-001",
      title: "First",
      type: "task",
      status: "open",
      phase: "p1",
      order: 10,
      rank: "A",
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    });
    writeJson(join(tickets, "t-0000000000000002.json"), {
      id: "t-0000000000000002",
      displayId: "T-002",
      title: "Second",
      type: "task",
      status: "open",
      phase: "p1",
      order: 20,
      rank: longRank,
      description: "",
      createdDate: "2026-01-02",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    });

    const result = await handleReconcile(root, { dryRun: false, ci: false, format: "md", rebalanceRanks: true });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No duplicate displayIds found");
    expect(result.output).toContain("Rebalanced");
    const second = JSON.parse(readFileSync(join(tickets, "t-0000000000000002.json"), "utf-8"));
    expect(second.rank.length).toBeLessThan(longRank.length);
    expect(readdirSync(join(root, ".story", "notes"))).toHaveLength(0);
  });

  describe("T-478: arrangements front-gate wiring", () => {
    it("a conflicted arrangement on disk blocks reconcile even when tickets are clean", async () => {
      const root = createProject();
      const arrangements = join(root, ".story", "arrangements");
      mkdirSync(arrangements, { recursive: true });
      writeJson(join(arrangements, "a-0123456789abcdef.json"), {
        id: "a-0123456789abcdef",
        lifecycle: "active",
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
          { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
        ],
        gates: [],
        unreachability: { onIrreversibleWork: "hold" },
        createdDate: "2026-08-27",
        updatedAt: "2026-08-27T00:00:00.000Z",
        _conflicts: [{ fieldPath: "lifecycle", kind: "field", base: "active", ours: "suspended", theirs: "closed" }],
      });

      const result = await handleReconcile(root, { dryRun: false, ci: false, format: "md" });

      expect(result.exitCode).toBe(ExitCode.VALIDATION_ERROR);
      expect(result.output).toContain("Unresolved conflict on arrangement a-0123456789abcdef");
    });

    it("a clean arrangement on disk does not block reconcile", async () => {
      const root = createProject();
      const arrangements = join(root, ".story", "arrangements");
      mkdirSync(arrangements, { recursive: true });
      writeJson(join(arrangements, "a-fedcba9876543210.json"), {
        id: "a-fedcba9876543210",
        lifecycle: "active",
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
          { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
        ],
        gates: [],
        unreachability: { onIrreversibleWork: "hold" },
        createdDate: "2026-08-27",
        updatedAt: "2026-08-27T00:00:00.000Z",
      });

      const result = await handleReconcile(root, { dryRun: false, ci: true, format: "json" });

      expect(result.exitCode).toBe(ExitCode.OK);
      const parsed = JSON.parse(result.output);
      expect(parsed.data.clean).toBe(true);
    });
  });

  describe("ISS-805: --ci clean project with format json", () => {
    it("emits a parseable success envelope and exits OK", async () => {
      const root = createProject(); // no tickets: clean, no renames, no rank changes
      const result = await handleReconcile(root, { dryRun: false, ci: true, format: "json" });
      expect(result.exitCode).toBe(ExitCode.OK);
      // RED before the fix: output is the bare string "No duplicate displayIds
      // found. Project is clean." so JSON.parse throws.
      const parsed = JSON.parse(result.output);
      expect(parsed.version).toBe(1);
      expect(parsed.data.clean).toBe(true);
    });
  });
});
