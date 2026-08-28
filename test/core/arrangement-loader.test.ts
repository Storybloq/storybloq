import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { loadArrangementsSafe, writeArrangementUnlocked } from "../../src/core/arrangement-loader.js";
import type { Arrangement } from "../../src/models/arrangement.js";

function baseArrangement(overrides: Record<string, unknown> = {}): Arrangement {
  return {
    id: "a-0123456789abcdef",
    lifecycle: "active",
    bounds: ["T-473"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
      { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    ...overrides,
  } as Arrangement;
}

describe("loadArrangementsSafe", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arrangement-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty, warning-free result when .story/arrangements/ does not exist", () => {
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("loads a valid arrangement written via writeArrangementUnlocked", async () => {
    const arrangement = baseArrangement();
    await writeArrangementUnlocked(arrangement, root, { createOnly: true });
    const result = loadArrangementsSafe(root);
    expect(result.warnings).toEqual([]);
    expect(result.arrangements).toHaveLength(1);
    expect(result.arrangements[0]?.id).toBe(arrangement.id);
  });

  it("reports a warning and skips a file over the size ceiling, without reading it in full (round-2 major finding)", async () => {
    await mkdir(join(root, ".story", "arrangements"), { recursive: true });
    // One byte over the 64 KiB ceiling -- readBoundedFile rejects on `fstat`
    // size alone, so this never becomes a multi-megabyte read in practice;
    // the test only needs to prove the boundary is enforced, not simulate
    // the multi-GB case the finding was about.
    const oversized = "x".repeat(65_536 + 1);
    await writeFile(join(root, ".story", "arrangements", "a-huge.json"), oversized);
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/exceeds size limit/);
  });

  it("reports a warning and skips invalid JSON, without throwing", async () => {
    await mkdir(join(root, ".story", "arrangements"), { recursive: true });
    await writeFile(join(root, ".story", "arrangements", "a-broken.json"), "{not json");
    expect(() => loadArrangementsSafe(root)).not.toThrow();
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/invalid JSON/);
  });

  it("reports a warning and skips a schema mismatch, without throwing", async () => {
    await mkdir(join(root, ".story", "arrangements"), { recursive: true });
    await writeFile(
      join(root, ".story", "arrangements", "a-bad.json"),
      JSON.stringify({ id: "a-bad", lifecycle: "active" }),
    );
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/schema mismatch/);
  });

  it("loads good arrangements alongside a broken one, warning only for the broken file", async () => {
    const good = baseArrangement({ id: "a-9876543210abcdef" });
    await writeArrangementUnlocked(good, root, { createOnly: true });
    await writeFile(join(root, ".story", "arrangements", "a-broken.json"), "{not json");
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toHaveLength(1);
    expect(result.arrangements[0]?.id).toBe(good.id);
    expect(result.warnings).toHaveLength(1);
  });

  // Root (and some CI/sandbox privilege models) bypasses Unix mode bits
  // entirely, so chmod(0o000) would not actually block enumeration there --
  // the test would then observe a normal empty-directory read and fail on an
  // assumption that has nothing to do with the loader's real behavior.
  it("skips a file whose contents' id does not match its own filename, with a warning", async () => {
    const arrangement = baseArrangement();
    await mkdir(join(root, ".story", "arrangements"), { recursive: true });
    await writeFile(
      join(root, ".story", "arrangements", "a-mismatched000.json"),
      JSON.stringify(arrangement),
    );
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/filename does not match record id/);
  });

  it("a same-id duplicate directory entry is impossible by construction: the filename-identity check already forecloses it", async () => {
    // A directory cannot hold two dirents with the same literal name, and
    // every accepted file's name must equal `${id}.json` (enforced above),
    // so no second file can ever pass that check for an id already loaded.
    // This case is covered by the "skips a file whose contents' id does not
    // match its own filename" test above -- a copy under a different name is
    // rejected there, never reaching a separate duplicate-id branch.
    const arrangement = baseArrangement();
    await writeArrangementUnlocked(arrangement, root, { createOnly: true });
    await writeFile(
      join(root, ".story", "arrangements", `${arrangement.id}-copy.json`),
      JSON.stringify(arrangement),
    );
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.stringMatching(/filename does not match record id/),
    ]);
  });

  it.skipIf(platform() === "win32")(
    "skips a symlink entry rather than following it, with a warning (never a blocking read)",
    async () => {
      const dir = join(root, ".story", "arrangements");
      await mkdir(dir, { recursive: true });
      const target = join(root, "outside-target.json");
      await writeFile(target, JSON.stringify(baseArrangement()));
      await symlink(target, join(dir, "a-0123456789abcdef.json"));
      const result = loadArrangementsSafe(root);
      expect(result.arrangements).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/not a regular file/);
    },
  );

  it.skipIf(platform() === "win32" || (process.geteuid?.() ?? process.getuid?.()) === 0)(
    "reports a directory-level warning when .story/arrangements/ exists but cannot be enumerated",
    async () => {
      const dir = join(root, ".story", "arrangements");
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o000);
      try {
        const result = loadArrangementsSafe(root);
        expect(result.arrangements).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/Could not read \.story\/arrangements\//);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );
});

describe("writeArrangementUnlocked", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arrangement-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("createOnly refuses to overwrite an existing file", async () => {
    const arrangement = baseArrangement();
    await writeArrangementUnlocked(arrangement, root, { createOnly: true });
    await expect(writeArrangementUnlocked(arrangement, root, { createOnly: true })).rejects.toThrow();
  });

  it("the ordinary (non-createOnly) path overwrites an existing file (binding item 3)", async () => {
    const arrangement = baseArrangement();
    await writeArrangementUnlocked(arrangement, root, { createOnly: true });
    const updated = { ...arrangement, lifecycle: "closed" as const };
    await expect(writeArrangementUnlocked(updated, root)).resolves.not.toThrow();
    const result = loadArrangementsSafe(root);
    expect(result.arrangements[0]?.lifecycle).toBe("closed");
  });

  it("rejects an arrangement whose id does not match the canonical arrangement id shape", async () => {
    const arrangement = baseArrangement({ id: "T-473" });
    await expect(writeArrangementUnlocked(arrangement, root)).rejects.toThrow();
  });
});
