import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { loadRulingsSafe, writeRulingUnlocked, RULING_MAX_BYTES } from "../../src/core/ruling-loader.js";
import type { Ruling } from "../../src/models/ruling.js";

function baseRuling(overrides: Record<string, unknown> = {}): Ruling {
  return {
    id: "r-0123456789abcdef",
    text: "The lens-cache evidence stands; the total is 337.",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "claude-session-abc" },
    date: "2026-08-27",
    scopeTags: [],
    supersedes: null,
    ...overrides,
  } as Ruling;
}

describe("loadRulingsSafe", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ruling-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty, warning-free, complete-scan result when .story/rulings/ does not exist", () => {
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.unavailableIds.size).toBe(0);
    expect(result.scanCompleteness).toBe("complete");
  });

  it("loads a valid ruling written via writeRulingUnlocked", async () => {
    const ruling = baseRuling();
    await writeRulingUnlocked(ruling, root, { createOnly: true });
    const result = loadRulingsSafe(root);
    expect(result.warnings).toEqual([]);
    expect(result.rulings).toHaveLength(1);
    expect(result.rulings[0]?.id).toBe(ruling.id);
    expect(result.scanCompleteness).toBe("complete");
  });

  it("reports a warning, skips, and records the id as unavailable for a file over the size ceiling", async () => {
    await mkdir(join(root, ".story", "rulings"), { recursive: true });
    const oversized = "x".repeat(RULING_MAX_BYTES + 1);
    await writeFile(join(root, ".story", "rulings", "r-1111111111111111.json"), oversized);
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/exceeds size limit/);
    expect(result.unavailableIds.has("r-1111111111111111")).toBe(true);
    expect(result.scanCompleteness).toBe("complete");
  });

  it("reports a warning and records the id as unavailable for invalid JSON, without throwing", async () => {
    await mkdir(join(root, ".story", "rulings"), { recursive: true });
    await writeFile(join(root, ".story", "rulings", "r-2222222222222222.json"), "{not json");
    expect(() => loadRulingsSafe(root)).not.toThrow();
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.warnings[0]).toMatch(/invalid JSON/);
    expect(result.unavailableIds.has("r-2222222222222222")).toBe(true);
  });

  it("reports a warning and records the id as unavailable for a schema mismatch", async () => {
    await mkdir(join(root, ".story", "rulings"), { recursive: true });
    await writeFile(
      join(root, ".story", "rulings", "r-3333333333333333.json"),
      JSON.stringify({ id: "r-3333333333333333", text: "" }),
    );
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.warnings[0]).toMatch(/schema mismatch/);
    expect(result.unavailableIds.has("r-3333333333333333")).toBe(true);
  });

  it("does not record an unavailable id when the broken filename itself is not a canonical ruling id shape, but sets hasUnrecoverableEntries (codex round-3 finding)", async () => {
    await mkdir(join(root, ".story", "rulings"), { recursive: true });
    await writeFile(join(root, ".story", "rulings", "not-a-ruling-id.json"), "{not json");
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.unavailableIds.size).toBe(0);
    // unavailableIds has no id to name here, but the taint must still
    // propagate: the unparseable content could carry any supersedes edge.
    expect(result.hasUnrecoverableEntries).toBe(true);
  });

  it("loads good rulings alongside a broken one, warning and unavailable-id only for the broken file", async () => {
    const good = baseRuling({ id: "r-9876543210abcdef" });
    await writeRulingUnlocked(good, root, { createOnly: true });
    await writeFile(join(root, ".story", "rulings", "r-4444444444444444.json"), "{not json");
    const result = loadRulingsSafe(root);
    expect(result.rulings).toHaveLength(1);
    expect(result.rulings[0]?.id).toBe(good.id);
    expect(result.warnings).toHaveLength(1);
    expect(result.unavailableIds.has("r-4444444444444444")).toBe(true);
    expect(result.unavailableIds.has(good.id)).toBe(false);
    // The broken file's id WAS recoverable from its filename, so the taint
    // is fully named in unavailableIds -- hasUnrecoverableEntries stays
    // false here, distinguishing this from the non-canonical-filename case.
    expect(result.hasUnrecoverableEntries).toBe(false);
  });

  it("skips a file whose contents' id does not match its own filename, with a warning", async () => {
    const ruling = baseRuling();
    await mkdir(join(root, ".story", "rulings"), { recursive: true });
    await writeFile(join(root, ".story", "rulings", "r-5555555555555555.json"), JSON.stringify(ruling));
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.warnings[0]).toMatch(/filename does not match record id/);
    // Both the misleading filename AND the record's own claimed id are
    // marked unavailable -- the record's own id is the one a citation
    // resolver actually looks up, so recording only the filename-derived id
    // would leave `ruling.id` looking untouched/nonexistent instead of
    // unreadable.
    expect(result.unavailableIds.has("r-5555555555555555")).toBe(true);
    expect(result.unavailableIds.has(ruling.id)).toBe(true);
  });

  it("marks the record's OWN id unavailable even when the filename itself is not a recoverable canonical shape (codex round-1 finding: a mismatched-name file could otherwise vanish from both `rulings` and `unavailableIds`)", async () => {
    // This is the case the filename-derived recovery alone cannot catch:
    // the file is validly-parsed content, but sits under a name that isn't
    // itself id-shaped, so `recoverIdFromFilename` finds nothing. Without
    // recording the record's OWN id, this ruling -- and any `supersedes`
    // edge it carries -- would disappear from the graph as if it never
    // existed, with `scanCompleteness` still reporting "complete": exactly
    // the T-055 staleness class this ticket exists to prevent.
    const superseding = baseRuling({ id: "r-6666666666666666", supersedes: "r-0123456789abcdef" });
    await mkdir(join(root, ".story", "rulings"), { recursive: true });
    await writeFile(join(root, ".story", "rulings", "copy-of-a-ruling.json"), JSON.stringify(superseding));
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.unavailableIds.has("r-6666666666666666")).toBe(true);
    // The taint is global (any unavailableIds nonempty), which is what
    // downstream resolveCitation relies on to report "indeterminate"
    // instead of falsely resolving r-0123456789abcdef as current.
    expect(result.unavailableIds.size).toBeGreaterThan(0);
  });

  it.skipIf(platform() === "win32")(
    "skips a symlink entry rather than following it, with a warning (never a blocking read)",
    async () => {
      const dir = join(root, ".story", "rulings");
      await mkdir(dir, { recursive: true });
      const target = join(root, "outside-target.json");
      await writeFile(target, JSON.stringify(baseRuling()));
      await symlink(target, join(dir, "r-0123456789abcdef.json"));
      const result = loadRulingsSafe(root);
      expect(result.rulings).toEqual([]);
      expect(result.warnings[0]).toMatch(/not a regular file/);
      expect(result.unavailableIds.has("r-0123456789abcdef")).toBe(true);
    },
  );

  it.skipIf(platform() === "win32" || (process.geteuid?.() ?? process.getuid?.()) === 0)(
    "reports a directory-level warning and scanCompleteness: incomplete when .story/rulings/ exists but cannot be enumerated",
    async () => {
      const dir = join(root, ".story", "rulings");
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o000);
      try {
        const result = loadRulingsSafe(root);
        expect(result.rulings).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/Could not read \.story\/rulings\//);
        expect(result.scanCompleteness).toBe("incomplete");
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );
});

describe("writeRulingUnlocked", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ruling-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("createOnly refuses to overwrite an existing file (content is immutable once created)", async () => {
    const ruling = baseRuling();
    await writeRulingUnlocked(ruling, root, { createOnly: true });
    await expect(writeRulingUnlocked(ruling, root, { createOnly: true })).rejects.toThrow();
  });

  it("the ordinary (non-createOnly) path overwrites an existing file -- used only to set supersedes once", async () => {
    const ruling = baseRuling();
    await writeRulingUnlocked(ruling, root, { createOnly: true });
    const superseding = { ...ruling, supersedes: "r-9876543210abcdef" };
    await expect(writeRulingUnlocked(superseding, root)).resolves.not.toThrow();
    const result = loadRulingsSafe(root);
    expect(result.rulings[0]?.supersedes).toBe("r-9876543210abcdef");
  });

  it("rejects a ruling whose id does not match the canonical ruling id shape", async () => {
    const ruling = baseRuling({ id: "T-473" });
    await expect(writeRulingUnlocked(ruling, root)).rejects.toThrow();
  });

  it("rejects a record whose full serialized size exceeds RULING_MAX_BYTES, even when text alone would fit", async () => {
    // The bulk comes from scopeTags, not `--text` -- proves the size check is
    // against the FULL serialized record, not the raw text value alone.
    const ruling = baseRuling({ scopeTags: Array.from({ length: 20_000 }, (_, i) => `tag-${i}`) });
    await expect(writeRulingUnlocked(ruling, root)).rejects.toThrow(/exceeds/);
  });
});
