import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { saveSnapshot } from "../../../src/core/snapshot.js";
import { handleRecap } from "../../../src/cli/commands/recap.js";
import { formatRecap } from "../../../src/core/output-formatter.js";
import {
  makeTicket,
  makeIssue,
  makePhase,
  makeRoadmap,
  makeState,
  minimalConfig,
  emptyRoadmap,
} from "../../core/test-factories.js";
import { buildRecap, type RecapStaleness } from "../../../src/core/snapshot.js";

describe("recap command", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns fallback when no snapshot exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const { state, warnings } = await loadProject(dir);
    const handoversDir = join(dir, ".story", "handovers");
    const result = await handleRecap({
      state,
      warnings,
      root: dir,
      handoversDir,
      format: "md",
    });
    expect(result.output).toContain("No snapshot found");
    expect(result.output).toContain("storybloq snapshot");
  });

  it("shows diff when snapshot exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    // Take snapshot
    const loadResult = await loadProject(dir);
    await saveSnapshot(dir, loadResult);

    // Load current state (same, so no changes)
    const { state, warnings } = await loadProject(dir);
    const handoversDir = join(dir, ".story", "handovers");
    const result = await handleRecap({
      state,
      warnings,
      root: dir,
      handoversDir,
      format: "md",
    });
    expect(result.output).toContain("Since snapshot:");
    expect(result.output).toContain("No changes since last snapshot");
  });

  it("returns valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const { state, warnings } = await loadProject(dir);
    const handoversDir = join(dir, ".story", "handovers");
    const result = await handleRecap({
      state,
      warnings,
      root: dir,
      handoversDir,
      format: "json",
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.snapshot).toBeNull();
    expect(parsed.data.changes).toBeNull();
    expect(parsed.data.suggestedActions).toBeDefined();
  });
});

describe("formatRecap", () => {
  it("MD shows suggested actions section", async () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const recap = await buildRecap(state, null, "/tmp");
    const md = formatRecap(recap, state, "md");
    expect(md).toContain("## Suggested Actions");
    expect(md).toContain("T-001");
  });

  it("MD shows changes when present", async () => {
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
      filename: "snap.json",
    };
    const recap = await buildRecap(currentState, snapshotInfo, "/tmp");
    const md = formatRecap(recap, currentState, "md");
    expect(md).toContain("Since snapshot:");
    expect(md).toContain("open → complete");
    expect(md).toContain("Phase Transitions");
  });

  it("T-486 U2-5: recap shows tickets withdrawn and no longer withdrawn, in md and json", async () => {
    const withdrawn = (id: string, reason: string) => makeTicket({
      id, phase: "p1", status: "complete", completedDate: "2026-03-05",
      ...({ resolutionKind: { kind: "withdrawn", closedOn: "2026-03-05", reason } } as object),
    });
    const delivered = (id: string) => makeTicket({ id, phase: "p1", status: "complete", completedDate: "2026-03-05" });
    const currentState = makeState({
      tickets: [withdrawn("T-004", "# Folded into T-9"), delivered("T-005")],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const snapshotInfo = {
      snapshot: {
        version: 1 as const,
        createdAt: new Date().toISOString(),
        project: "test",
        config: minimalConfig,
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
        tickets: [delivered("T-004"), withdrawn("T-005", "Was dropped")],
        issues: [],
        notes: [],
        lessons: [],
        handoverFilenames: [],
      },
      filename: "snap.json",
    };
    const recap = await buildRecap(currentState, snapshotInfo, "/tmp");
    const md = formatRecap(recap, currentState, "md");
    expect(md).toContain("Since snapshot:");
    expect(md).toContain("- Withdrawn: T-004 (\\# Folded into T-9)");
    expect(md).toContain("- No longer withdrawn: T-005");
    const json = JSON.parse(formatRecap(recap, currentState, "json")).data;
    expect(json.changes.tickets.withdrawn).toEqual([{ id: "T-004", title: "Test T-004", reason: "# Folded into T-9" }]);
    expect(json.changes.tickets.withdrawalCleared).toEqual([{ id: "T-005", title: "Test T-005" }]);
  });

  it("MD shows partial warning when snapshot had warnings", async () => {
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
        warnings: [{ type: "parse_error", file: "bad.json", message: "bad" }],
      },
      filename: "snap.json",
    };
    const recap = await buildRecap(state, snapshotInfo, "/tmp");
    const md = formatRecap(recap, state, "md");
    expect(md).toContain("integrity warnings");
  });

  it("MD shows high severity issues in actions", async () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", title: "Crash" }),
      ],
    });
    const recap = await buildRecap(state, null, "/tmp");
    const md = formatRecap(recap, state, "md");
    expect(md).toContain("critical issue");
    expect(md).toContain("Crash");
  });

  it("MD shows only the first five high-severity issues, with a critical issue surfaced ahead of more than five high issues in filesystem order, plus an overflow line reporting omitted counts per severity (T-320 commit 4)", async () => {
    const state = makeState({
      issues: [
        // Six "high" issues filed first (filesystem/insertion order), then one
        // "critical" issue filed last. A naive slice(0, 5) over unsorted data
        // would drop the critical issue entirely.
        ...Array.from({ length: 6 }, (_, n) =>
          makeIssue({ id: `ISS-1${n}`, severity: "high", discoveredDate: "2026-01-01" }),
        ),
        makeIssue({ id: "ISS-200", severity: "critical", title: "Data loss", discoveredDate: "2026-06-01" }),
      ],
    });
    const recap = await buildRecap(state, null, "/tmp");
    const md = formatRecap(recap, state, "md");
    expect(md).toContain("ISS-200");
    expect(md).toContain("Data loss");
    const shownHighLines = (md.match(/high issue:/g) ?? []).length;
    // 1 critical + 5 total shown => 4 high shown, 2 high omitted (6 - 4).
    expect(shownHighLines).toBe(4);
    expect(md).toMatch(/2 more issues? omitted/);
    expect(md).toContain("2 high");
    expect(md).not.toMatch(/\d+ critical/); // no critical issues were omitted
  });

  it("MD omits the overflow line when five or fewer high-severity issues exist", async () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical" }),
        makeIssue({ id: "ISS-002", severity: "high" }),
      ],
    });
    const recap = await buildRecap(state, null, "/tmp");
    const md = formatRecap(recap, state, "md");
    expect(md).not.toMatch(/omitted/);
  });

  describe("staleness wording (ISS-889)", () => {
    // formatRecap is fed a RecapResult directly: buildRecap would need a real git
    // repo with a specific commit distance, and the defect is purely in rendering.
    const withStaleness = async (staleness: RecapStaleness) => {
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
        filename: "snap.json",
      };
      const recap = await buildRecap(state, snapshotInfo, "/tmp");
      return formatRecap({ ...recap, staleness }, state, "md");
    };

    const behind = (commitsBehind: number): RecapStaleness => ({
      status: "behind",
      snapshotSha: "aaaaaaa",
      currentSha: "bbbbbbb",
      commitsBehind,
    });

    it("states being behind HEAD as a fact, not a warning", async () => {
      // Being behind is what happens whenever you take a snapshot and keep
      // working. Phrasing it as a warning trains readers to skip the prefix.
      const md = await withStaleness(behind(3));
      expect(md).toContain("Snapshot is 3 commits behind HEAD.");
      expect(md).not.toContain("**Warning:** Snapshot is");
      expect(md).not.toContain("context may be stale");
    });

    it("uses the singular for one commit", async () => {
      const md = await withStaleness(behind(1));
      expect(md).toContain("Snapshot is 1 commit behind HEAD.");
      expect(md).not.toContain("1 commits");
    });

    it("still warns when history diverged, which is not routine", async () => {
      // The whole point of demoting the routine case: this one keeps its signal.
      const md = await withStaleness({
        status: "diverged",
        snapshotSha: "aaaaaaa",
        currentSha: "bbbbbbb",
      });
      expect(md).toContain("**Warning:**");
      expect(md).toContain("history diverged");
    });

    it("says nothing about staleness when the snapshot is current", async () => {
      const state = makeState();
      const recap = await buildRecap(state, null, "/tmp");
      expect(recap.staleness).toBeUndefined();
      expect(formatRecap(recap, state, "md")).not.toContain("behind HEAD");
    });
  });

  it("JSON envelope matches RecapResult shape", async () => {
    const state = makeState();
    const recap = await buildRecap(state, null, "/tmp");
    const json = formatRecap(recap, state, "json");
    const parsed = JSON.parse(json);
    expect(parsed.data).toHaveProperty("snapshot");
    expect(parsed.data).toHaveProperty("changes");
    expect(parsed.data).toHaveProperty("suggestedActions");
    expect(parsed.data).toHaveProperty("partial");
  });
});
