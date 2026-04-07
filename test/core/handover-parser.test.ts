import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listHandovers,
  readHandover,
  extractHandoverDate,
  extractHandoverTitle,
} from "../../src/core/handover-parser.js";
import type { LoadWarning } from "../../src/core/errors.js";

let root: string;
let handoversDir: string;
let warnings: LoadWarning[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claudestory-hp-"));
  handoversDir = join(root, ".story", "handovers");
  await mkdir(handoversDir, { recursive: true });
  warnings = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listHandovers", () => {
  it("lists .md files sorted newest-first", async () => {
    await writeFile(join(handoversDir, "2026-01-01-first.md"), "First");
    await writeFile(join(handoversDir, "2026-03-15-third.md"), "Third");
    await writeFile(join(handoversDir, "2026-02-10-second.md"), "Second");

    const result = await listHandovers(handoversDir, root, warnings);
    expect(result).toEqual([
      "2026-03-15-third.md",
      "2026-02-10-second.md",
      "2026-01-01-first.md",
    ]);
    expect(warnings).toHaveLength(0);
  });

  it("appends non-conforming filenames at end with warning", async () => {
    await writeFile(join(handoversDir, "2026-01-01-dated.md"), "Dated");
    await writeFile(join(handoversDir, "notes.md"), "Notes");

    const result = await listHandovers(handoversDir, root, warnings);
    expect(result).toEqual(["2026-01-01-dated.md", "notes.md"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe("naming_convention");
  });

  it("skips hidden files and non-.md files", async () => {
    await writeFile(join(handoversDir, ".DS_Store"), "");
    await writeFile(join(handoversDir, "readme.txt"), "");
    await writeFile(join(handoversDir, "2026-01-01-valid.md"), "Valid");

    const result = await listHandovers(handoversDir, root, warnings);
    expect(result).toEqual(["2026-01-01-valid.md"]);
  });

  it("returns empty array for missing directory (no error)", async () => {
    const missing = join(root, ".story", "nonexistent");
    const result = await listHandovers(missing, root, warnings);
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(0);
  });
});

describe("readHandover", () => {
  it("returns file content as string", async () => {
    await writeFile(join(handoversDir, "2026-01-01-test.md"), "# Session\nContent here.");
    const content = await readHandover(handoversDir, "2026-01-01-test.md");
    expect(content).toBe("# Session\nContent here.");
  });
});

describe("extractHandoverDate", () => {
  it("extracts date from conforming filename", () => {
    expect(extractHandoverDate("2026-03-15-session.md")).toBe("2026-03-15");
  });

  it("returns null for non-conforming filename", () => {
    expect(extractHandoverDate("notes.md")).toBeNull();
    expect(extractHandoverDate("session-2026-03-15.md")).toBeNull();
  });
});

describe("extractHandoverTitle", () => {
  it("strips date prefix and extension, converts hyphens to spaces", () => {
    expect(extractHandoverTitle("2026-03-15-01-session-handover.md")).toBe("01 session handover");
  });

  it("handles filenames without sequence number", () => {
    expect(extractHandoverTitle("2026-03-15-session-title.md")).toBe("session title");
  });

  it("returns full filename (minus .md) for non-conforming names", () => {
    expect(extractHandoverTitle("notes.md")).toBe("notes");
  });

  it("handles auto-session suffix", () => {
    expect(extractHandoverTitle("2026-04-06-12-auto-session.md")).toBe("12 auto session");
  });

  it("returns empty string for date-only filename", () => {
    expect(extractHandoverTitle("2026-03-15.md")).toBe("");
  });
});
