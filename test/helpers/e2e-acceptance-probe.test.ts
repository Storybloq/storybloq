import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillTargets } from "../../src/core/skill-version-marker.js";
import {
  auditedPaths,
  snapshotAuditedPaths,
  diffAuditedPaths,
  classifyDiffs,
  skillMarkerCodexConfigPath,
  setupSkillCodexConfigPath,
  type AuditedPath,
  type AuditedPathDiff,
} from "./e2e-acceptance-probe.js";

describe("auditedPaths (anti-staleness -- F10)", () => {
  it("names exactly the current skillTargets(), not a hardcoded copy", () => {
    const real = skillTargets();
    const audited = auditedPaths().filter((p) => p.kind === "dir");
    expect(audited).toHaveLength(real.length);
    for (const target of real) {
      const entry = audited.find((p) => p.label === `skill dir (${target.id})`);
      expect(entry).toBeDefined();
      expect(entry!.path).toBe(target.dir);
    }
  });

  it("pins the two independent codexConfigPath definitions as equal (documented duplication)", () => {
    expect(skillMarkerCodexConfigPath()).toBe(setupSkillCodexConfigPath());
  });

  it("marks the version-skew/drift-reconcile targets hard, and the concurrent-live-write targets warn (P1)", () => {
    const all = auditedPaths();
    const warnLabels = all.filter((p) => p.severity === "warn").map((p) => p.label);
    expect(warnLabels.sort()).toEqual(["limit ledger", "update-check cache", "waker lock"].sort());
    const hardLabels = all.filter((p) => p.severity === "hard").map((p) => p.label);
    expect(hardLabels).toHaveLength(all.length - warnLabels.length);
    expect(hardLabels).toEqual(expect.arrayContaining(["codex config.toml", "codex hooks.json", "claude settings.json"]));
    for (const target of skillTargets()) {
      expect(hardLabels).toContain(`skill dir (${target.id})`);
    }
  });

  it("includes one entry per named non-skill-dir write target", () => {
    const labels = auditedPaths()
      .filter((p) => p.kind === "file")
      .map((p) => p.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "codex config.toml",
        "codex hooks.json",
        "claude settings.json",
        "update-check cache",
        "limit ledger",
        "waker lock",
      ]),
    );
  });
});

describe("snapshotAuditedPaths / diffAuditedPaths", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function scratchPaths(): Promise<{ root: string; file: AuditedPath; dir: AuditedPath }> {
    root = await mkdtemp(join(tmpdir(), "storybloq-probe-test-"));
    const filePath = join(root, "some-file.json");
    const dirPath = join(root, "some-dir");
    return {
      root,
      file: { label: "scratch file", path: filePath, kind: "file", severity: "hard" },
      dir: { label: "scratch dir", path: dirPath, kind: "dir", severity: "hard" },
    };
  }

  it("reports null for a path that does not exist yet", async () => {
    const { file } = await scratchPaths();
    const snap = snapshotAuditedPaths([file]);
    expect(snap["scratch file"]).toBeNull();
  });

  it("detects an existence-only change: absent before, present after", async () => {
    const { file } = await scratchPaths();
    const before = snapshotAuditedPaths([file]);
    await writeFile(file.path, "hello", "utf-8");
    const after = snapshotAuditedPaths([file]);
    const diffs = diffAuditedPaths(before, after);
    expect(diffs).toEqual([{ label: "scratch file", before: null, after: expect.any(String) }]);
  });

  it("detects the reverse direction: present before, removed after", async () => {
    const { file } = await scratchPaths();
    await writeFile(file.path, "hello", "utf-8");
    const before = snapshotAuditedPaths([file]);
    await rm(file.path);
    const after = snapshotAuditedPaths([file]);
    const diffs = diffAuditedPaths(before, after);
    expect(diffs).toEqual([{ label: "scratch file", before: expect.any(String), after: null }]);
  });

  it("detects a content change with no existence change", async () => {
    const { file } = await scratchPaths();
    await writeFile(file.path, "hello", "utf-8");
    const before = snapshotAuditedPaths([file]);
    await writeFile(file.path, "goodbye", "utf-8");
    const after = snapshotAuditedPaths([file]);
    const diffs = diffAuditedPaths(before, after);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.before).not.toBe(diffs[0]!.after);
  });

  it("reports no diff when nothing changed", async () => {
    const { file } = await scratchPaths();
    await writeFile(file.path, "hello", "utf-8");
    const before = snapshotAuditedPaths([file]);
    const after = snapshotAuditedPaths([file]);
    expect(diffAuditedPaths(before, after)).toEqual([]);
  });

  it("recursively hashes a directory, catching an added file even when no top-level path changed", async () => {
    const { dir } = await scratchPaths();
    await mkdir(dir.path, { recursive: true });
    const before = snapshotAuditedPaths([dir]);
    await writeFile(join(dir.path, "nested.txt"), "new content", "utf-8");
    const after = snapshotAuditedPaths([dir]);
    const diffs = diffAuditedPaths(before, after);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.before).not.toBe(diffs[0]!.after);
  });
});

describe("classifyDiffs (P1: severity split)", () => {
  const paths: AuditedPath[] = [
    { label: "hard target", path: "/irrelevant/hard", kind: "file", severity: "hard" },
    { label: "warn target", path: "/irrelevant/warn", kind: "file", severity: "warn" },
  ];
  const diffs: AuditedPathDiff[] = [
    { label: "hard target", before: "a", after: "b" },
    { label: "warn target", before: "c", after: "d" },
  ];

  it("routes a hard-severity diff to hard and a warn-severity diff to warn, non-strict", () => {
    const { hard, warn } = classifyDiffs(diffs, paths, false);
    expect(hard.map((d) => d.label)).toEqual(["hard target"]);
    expect(warn.map((d) => d.label)).toEqual(["warn target"]);
  });

  it("promotes every warn diff to hard under STRICT", () => {
    const { hard, warn } = classifyDiffs(diffs, paths, true);
    expect(hard.map((d) => d.label).sort()).toEqual(["hard target", "warn target"]);
    expect(warn).toEqual([]);
  });

  it("classifies an unrecognized label (not in the paths list) as hard, fail-safe", () => {
    const strayDiff: AuditedPathDiff = { label: "unknown target", before: null, after: "x" };
    const { hard, warn } = classifyDiffs([strayDiff], paths, false);
    expect(hard).toEqual([strayDiff]);
    expect(warn).toEqual([]);
  });
});
