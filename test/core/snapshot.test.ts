import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectState } from "../../src/core/project-state.js";
import {
  saveSnapshot,
  loadLatestSnapshot,
  diffStates,
  buildRecap,
  SnapshotV1Schema,
} from "../../src/core/snapshot.js";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import {
  makeTicket,
  makeIssue,
  makePhase,
  makeRoadmap,
  makeState,
  minimalConfig,
  emptyRoadmap,
} from "./test-factories.js";

describe("snapshot", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  async function setupProject(name = "test"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "snap-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name });
    return dir;
  }

  describe("saveSnapshot", () => {
    it("creates a snapshot file in .story/snapshots/", async () => {
      const dir = await setupProject();
      const loadResult = await loadProject(dir);
      const result = await saveSnapshot(dir, loadResult);
      expect(result.filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/);
      expect(result.retained).toBe(1);
      expect(result.pruned).toBe(0);

      const files = await readdir(join(dir, ".story", "snapshots"));
      expect(files).toContain(result.filename);
    });

    it("creates snapshots/ directory if missing", async () => {
      const dir = await setupProject();
      const loadResult = await loadProject(dir);
      const result = await saveSnapshot(dir, loadResult);
      expect(result.retained).toBe(1);
    });

    it("produces valid SnapshotV1 JSON", async () => {
      const dir = await setupProject();
      const loadResult = await loadProject(dir);
      const result = await saveSnapshot(dir, loadResult);

      const { readFile } = await import("node:fs/promises");
      const content = await readFile(
        join(dir, ".story", "snapshots", result.filename),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(() => SnapshotV1Schema.parse(parsed)).not.toThrow();
      expect(parsed.version).toBe(1);
      expect(parsed.project).toBe("test");
    });

    it("includes warnings when present", async () => {
      const dir = await setupProject();
      // Write a corrupt ticket to trigger a warning
      await writeFile(join(dir, ".story", "tickets", "T-099.json"), "{bad");
      const loadResult = await loadProject(dir);
      expect(loadResult.warnings.length).toBeGreaterThan(0);

      const result = await saveSnapshot(dir, loadResult);
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(
        join(dir, ".story", "snapshots", result.filename),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.warnings).toBeDefined();
      expect(parsed.warnings.length).toBeGreaterThan(0);
    });

    it("prunes old snapshots beyond 20", async () => {
      const dir = await setupProject();
      const loadResult = await loadProject(dir);

      // Create snapshots dir and seed 22 files
      const snapshotsDir = join(dir, ".story", "snapshots");
      await mkdir(snapshotsDir, { recursive: true });
      for (let i = 0; i < 22; i++) {
        const filename = `2026-01-01T00-00-${String(i).padStart(2, "0")}-000.json`;
        await writeFile(join(snapshotsDir, filename), '{"version":1}');
      }

      const result = await saveSnapshot(dir, loadResult);
      // 22 pre-existing + 1 new = 23, pruned to 20
      expect(result.pruned).toBe(3);
      expect(result.retained).toBe(20);
    });
  });

  describe("loadLatestSnapshot", () => {
    it("returns null when no snapshots dir exists", async () => {
      const dir = await setupProject();
      const result = await loadLatestSnapshot(dir);
      expect(result).toBeNull();
    });

    it("returns null when snapshots dir is empty", async () => {
      const dir = await setupProject();
      await mkdir(join(dir, ".story", "snapshots"), { recursive: true });
      const result = await loadLatestSnapshot(dir);
      expect(result).toBeNull();
    });

    it("loads the newest valid snapshot", async () => {
      const dir = await setupProject();
      const loadResult = await loadProject(dir);

      await saveSnapshot(dir, loadResult);
      // Small delay for unique filename
      await new Promise((r) => setTimeout(r, 5));
      await saveSnapshot(dir, loadResult);

      const result = await loadLatestSnapshot(dir);
      expect(result).not.toBeNull();
      expect(result!.snapshot.version).toBe(1);
    });

    it("skips corrupt snapshots and returns next valid one", async () => {
      const dir = await setupProject();
      const loadResult = await loadProject(dir);

      // Create a valid snapshot first
      const saveResult = await saveSnapshot(dir, loadResult);

      // Create a newer corrupt snapshot
      await writeFile(
        join(dir, ".story", "snapshots", "9999-12-31T23-59-59-999.json"),
        "{corrupt",
      );

      const result = await loadLatestSnapshot(dir);
      expect(result).not.toBeNull();
      // Should have fallen back to the valid one
      expect(result!.filename).toBe(saveResult.filename);
    });

    it("returns null when all snapshots are corrupt", async () => {
      const dir = await setupProject();
      await mkdir(join(dir, ".story", "snapshots"), { recursive: true });
      await writeFile(
        join(dir, ".story", "snapshots", "2026-01-01T00-00-00-000.json"),
        "{bad",
      );
      await writeFile(
        join(dir, ".story", "snapshots", "2026-01-02T00-00-00-000.json"),
        "not json",
      );

      const result = await loadLatestSnapshot(dir);
      expect(result).toBeNull();
    });
  });

  describe("diffStates", () => {
    it("detects added tickets", () => {
      const snap = makeState({
        tickets: [makeTicket({ id: "T-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const cur = makeState({
        tickets: [
          makeTicket({ id: "T-001" }),
          makeTicket({ id: "T-002", title: "New one" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });

      const diff = diffStates(snap, cur);
      expect(diff.tickets.added).toEqual([{ id: "T-002", title: "New one" }]);
      expect(diff.tickets.removed).toEqual([]);
    });

    it("detects removed tickets", () => {
      const snap = makeState({
        tickets: [
          makeTicket({ id: "T-001" }),
          makeTicket({ id: "T-002", title: "Gone" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const cur = makeState({
        tickets: [makeTicket({ id: "T-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });

      const diff = diffStates(snap, cur);
      expect(diff.tickets.removed).toEqual([{ id: "T-002", title: "Gone" }]);
    });

    it("detects ticket status changes", () => {
      const snap = makeState({
        tickets: [makeTicket({ id: "T-001", status: "open" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const cur = makeState({
        tickets: [makeTicket({ id: "T-001", status: "complete" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });

      const diff = diffStates(snap, cur);
      expect(diff.tickets.statusChanged).toHaveLength(1);
      expect(diff.tickets.statusChanged[0]).toMatchObject({
        id: "T-001",
        from: "open",
        to: "complete",
      });
    });

    it("detects added issues", () => {
      const snap = makeState();
      const cur = makeState({
        issues: [makeIssue({ id: "ISS-001", title: "Bug" })],
      });

      const diff = diffStates(snap, cur);
      expect(diff.issues.added).toEqual([{ id: "ISS-001", title: "Bug" }]);
    });

    it("detects resolved issues", () => {
      const snap = makeState({
        issues: [makeIssue({ id: "ISS-001", status: "open" })],
      });
      const cur = makeState({
        issues: [makeIssue({ id: "ISS-001", status: "resolved" })],
      });

      const diff = diffStates(snap, cur);
      expect(diff.issues.resolved).toHaveLength(1);
      expect(diff.issues.resolved[0]!.id).toBe("ISS-001");
    });

    it("detects issue status changes (not resolved)", () => {
      const snap = makeState({
        issues: [makeIssue({ id: "ISS-001", status: "open" })],
      });
      const cur = makeState({
        issues: [makeIssue({ id: "ISS-001", status: "inprogress" })],
      });

      const diff = diffStates(snap, cur);
      expect(diff.issues.statusChanged).toHaveLength(1);
      expect(diff.issues.statusChanged[0]).toMatchObject({
        from: "open",
        to: "inprogress",
      });
    });

    it("detects phase status transitions", () => {
      const snap = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const cur = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });

      const diff = diffStates(snap, cur);
      expect(diff.phases.statusChanged).toHaveLength(1);
      expect(diff.phases.statusChanged[0]).toMatchObject({
        id: "p1",
        from: "notstarted",
        to: "complete",
      });
    });

    it("detects added phases", () => {
      const snap = makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const cur = makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2", name: "New Phase" })]),
      });

      const diff = diffStates(snap, cur);
      expect(diff.phases.added).toEqual([{ id: "p2", name: "New Phase" }]);
    });

    it("detects removed phases", () => {
      const snap = makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2", name: "Gone" })]),
      });
      const cur = makeState({
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });

      const diff = diffStates(snap, cur);
      expect(diff.phases.removed).toEqual([{ id: "p2", name: "Gone" }]);
    });

    it("detects added blockers", () => {
      const snap = makeState({
        roadmap: { ...emptyRoadmap, blockers: [] },
      });
      const cur = makeState({
        roadmap: {
          ...emptyRoadmap,
          blockers: [{ name: "New blocker", cleared: false, createdDate: "2026-03-20" }],
        },
      });

      const diff = diffStates(snap, cur);
      expect(diff.blockers.added).toEqual(["New blocker"]);
    });

    it("detects cleared blockers", () => {
      const snap = makeState({
        roadmap: {
          ...emptyRoadmap,
          blockers: [{ name: "API key", cleared: false, createdDate: "2026-03-10" }],
        },
      });
      const cur = makeState({
        roadmap: {
          ...emptyRoadmap,
          blockers: [
            { name: "API key", cleared: true, createdDate: "2026-03-10", clearedDate: "2026-03-20" },
          ],
        },
      });

      const diff = diffStates(snap, cur);
      expect(diff.blockers.cleared).toEqual(["API key"]);
    });

    it("returns empty diff when nothing changed", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });

      const diff = diffStates(state, state);
      expect(diff.tickets.added).toEqual([]);
      expect(diff.tickets.removed).toEqual([]);
      expect(diff.tickets.statusChanged).toEqual([]);
      expect(diff.issues.added).toEqual([]);
      expect(diff.issues.resolved).toEqual([]);
      expect(diff.phases.statusChanged).toEqual([]);
      expect(diff.blockers.added).toEqual([]);
      expect(diff.blockers.cleared).toEqual([]);
    });
  });

  describe("buildRecap", () => {
    it("returns null changes when no snapshot", () => {
      const state = makeState();
      const recap = buildRecap(state, null);
      expect(recap.snapshot).toBeNull();
      expect(recap.changes).toBeNull();
      expect(recap.partial).toBe(false);
    });

    it("includes suggested actions even without snapshot", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
        issues: [makeIssue({ id: "ISS-001", severity: "critical" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const recap = buildRecap(state, null);
      expect(recap.suggestedActions.nextTicket).not.toBeNull();
      expect(recap.suggestedActions.nextTicket!.id).toBe("T-001");
      expect(recap.suggestedActions.highSeverityIssues).toHaveLength(1);
    });

    it("sets partial=true when snapshot had warnings", () => {
      const state = makeState();
      const snapshotInfo = {
        snapshot: {
          version: 1 as const,
          createdAt: new Date().toISOString(),
          project: "test",
          config: minimalConfig,
          roadmap: emptyRoadmap,
          tickets: [],
          issues: [],
          warnings: [{ type: "parse_error", file: "T-099.json", message: "bad" }],
        },
        filename: "2026-03-20T00-00-00-000.json",
      };
      const recap = buildRecap(state, snapshotInfo);
      expect(recap.partial).toBe(true);
    });

    it("sets partial=false when snapshot had no warnings", () => {
      const state = makeState();
      const snapshotInfo = {
        snapshot: {
          version: 1 as const,
          createdAt: new Date().toISOString(),
          project: "test",
          config: minimalConfig,
          roadmap: emptyRoadmap,
          tickets: [],
          issues: [],
        },
        filename: "2026-03-20T00-00-00-000.json",
      };
      const recap = buildRecap(state, snapshotInfo);
      expect(recap.partial).toBe(false);
    });

    it("populates changes when snapshot exists", () => {
      const currentState = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const snapshotInfo = {
        snapshot: {
          version: 1 as const,
          createdAt: new Date().toISOString(),
          project: "test",
          config: minimalConfig,
          roadmap: makeRoadmap([makePhase({ id: "p1" })]),
          tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
          issues: [],
        },
        filename: "2026-03-20T00-00-00-000.json",
      };
      const recap = buildRecap(currentState, snapshotInfo);
      expect(recap.changes).not.toBeNull();
      expect(recap.changes!.tickets.statusChanged).toHaveLength(1);
      expect(recap.changes!.phases.statusChanged).toHaveLength(1);
    });

    it("filters high severity issues for suggested actions", () => {
      const state = makeState({
        issues: [
          makeIssue({ id: "ISS-001", severity: "critical" }),
          makeIssue({ id: "ISS-002", severity: "low" }),
          makeIssue({ id: "ISS-003", severity: "high" }),
          makeIssue({ id: "ISS-004", severity: "medium" }),
          makeIssue({ id: "ISS-005", severity: "high", status: "resolved" }),
        ],
      });
      const recap = buildRecap(state, null);
      // Only critical + high, excluding resolved
      expect(recap.suggestedActions.highSeverityIssues).toHaveLength(2);
      const ids = recap.suggestedActions.highSeverityIssues.map((i) => i.id);
      expect(ids).toContain("ISS-001");
      expect(ids).toContain("ISS-003");
    });
  });
});
