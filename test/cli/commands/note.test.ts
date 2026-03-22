import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleNoteList,
  handleNoteGet,
  handleNoteCreate,
  handleNoteUpdate,
  handleNoteDelete,
} from "../../../src/cli/commands/note.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState, makeNote } from "../../core/test-factories.js";
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

// --- List ---

describe("handleNoteList", () => {
  it("returns all notes with no filters", () => {
    const ctx = makeCtx({
      state: makeState({
        notes: [
          makeNote({ id: "N-001", title: "Note A" }),
          makeNote({ id: "N-002", title: "Note B" }),
        ],
      }),
    });
    const result = handleNoteList({}, ctx);
    expect(result.output).toContain("N-001");
    expect(result.output).toContain("N-002");
  });

  it("filters by status (active only)", () => {
    const ctx = makeCtx({
      state: makeState({
        notes: [
          makeNote({ id: "N-001", status: "active" }),
          makeNote({ id: "N-002", status: "archived" }),
        ],
      }),
    });
    const result = handleNoteList({ status: "active" }, ctx);
    expect(result.output).toContain("N-001");
    expect(result.output).not.toContain("N-002");
  });

  it("filters by tag", () => {
    const ctx = makeCtx({
      state: makeState({
        notes: [
          makeNote({ id: "N-001", tags: ["architecture", "design"] }),
          makeNote({ id: "N-002", tags: ["roadmap"] }),
        ],
      }),
    });
    const result = handleNoteList({ tag: "architecture" }, ctx);
    expect(result.output).toContain("N-001");
    expect(result.output).not.toContain("N-002");
  });

  it("returns empty message when no notes", () => {
    const ctx = makeCtx();
    const result = handleNoteList({}, ctx);
    expect(result.output).toContain("No notes");
  });

  it("sorts by updatedDate desc, then id asc within same day", () => {
    const ctx = makeCtx({
      state: makeState({
        notes: [
          makeNote({ id: "N-003", updatedDate: "2026-03-20" }),
          makeNote({ id: "N-001", updatedDate: "2026-03-21" }),
          makeNote({ id: "N-002", updatedDate: "2026-03-21" }),
        ],
      }),
      format: "json",
    });
    const result = handleNoteList({}, ctx);
    const parsed = JSON.parse(result.output);
    const ids = parsed.data.map((n: { id: string }) => n.id);
    // N-001 and N-002 share 2026-03-21 (sorted asc by id), N-003 is older
    expect(ids).toEqual(["N-001", "N-002", "N-003"]);
  });
});

// --- Get ---

describe("handleNoteGet", () => {
  it("returns note when found", () => {
    const ctx = makeCtx({
      state: makeState({
        notes: [makeNote({ id: "N-001", title: "My Note" })],
      }),
    });
    const result = handleNoteGet("N-001", ctx);
    expect(result.output).toContain("My Note");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns not_found when missing", () => {
    const ctx = makeCtx();
    const result = handleNoteGet("N-999", ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });
});

// --- Create ---

describe("handleNoteCreate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("creates a note with content only (minimal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleNoteCreate(
      { content: "Just a quick thought." },
      "md", dir,
    );
    expect(result.output).toContain("Created note N-001");
    const raw = await readFile(join(dir, ".story", "notes", "N-001.json"), "utf-8");
    const note = JSON.parse(raw);
    expect(note.content).toBe("Just a quick thought.");
    expect(note.title).toBeNull();
    expect(note.tags).toEqual([]);
    expect(note.status).toBe("active");
  });

  it("creates a note with title and tags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleNoteCreate(
      { content: "Design ideas.", title: "Architecture", tags: ["design", "brainstorm"] },
      "json", dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.title).toBe("Architecture");
    expect(parsed.data.tags).toEqual(["design", "brainstorm"]); // normalizeTags dedupes, preserves order
  });

  it("rejects empty content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleNoteCreate({ content: "" }, "md", dir),
    ).rejects.toThrow();
  });
});

// --- Update ---

describe("handleNoteUpdate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupNote(dir: string) {
    await initProject(dir, { name: "test" });
    await handleNoteCreate(
      { content: "Original content.", title: "Original Title", tags: ["alpha"] },
      "md", dir,
    );
  }

  it("updates content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const result = await handleNoteUpdate("N-001", { content: "Updated content." }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.content).toBe("Updated content.");
  });

  it("updates status to archived", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const result = await handleNoteUpdate("N-001", { status: "archived" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("archived");
  });

  it("updates tags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const result = await handleNoteUpdate("N-001", { tags: ["beta", "gamma"] }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.tags).toEqual(["beta", "gamma"]);
  });

  it("sets title to null via empty string", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const result = await handleNoteUpdate("N-001", { title: "" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.title).toBeNull();
  });

  it("clears tags via clearTags flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const result = await handleNoteUpdate("N-001", { clearTags: true }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.tags).toEqual([]);
  });

  it("returns not_found for missing note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleNoteUpdate("N-999", { content: "X" }, "md", dir),
    ).rejects.toThrow("not found");
  });
});

// --- Delete ---

describe("handleNoteDelete", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("deletes a note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleNoteCreate(
      { content: "Doomed note." },
      "md", dir,
    );
    const result = await handleNoteDelete("N-001", "md", dir);
    expect(result.output).toContain("Deleted note N-001");
  });

  it("throws for missing note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleNoteDelete("N-999", "md", dir),
    ).rejects.toThrow();
  });
});
