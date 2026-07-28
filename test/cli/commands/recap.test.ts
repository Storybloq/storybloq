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
