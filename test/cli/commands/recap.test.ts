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
import { buildRecap } from "../../../src/core/snapshot.js";

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
    expect(result.output).toContain("claudestory snapshot");
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
