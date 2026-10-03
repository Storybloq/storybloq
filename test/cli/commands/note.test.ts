import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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

async function enableTeamMode(dir: string): Promise<void> {
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.team = { ...(config.team ?? {}), enabled: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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

  it("ISS-805: reports invalid_input (not not_found) for an ambiguous ref", () => {
    // Two notes sharing a displayId make N-900 an ambiguous ref.
    const ctx = makeCtx({
      state: makeState({
        notes: [
          makeNote({ id: "n-000000000000aa01", displayId: "N-900" }),
          makeNote({ id: "n-000000000000aa02", displayId: "N-900" }),
        ],
      }),
    });
    const result = handleNoteGet("N-900", ctx);
    expect(result.errorCode).toBe("invalid_input");
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

  it("creates canonical IDs with display IDs in explicit team mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await enableTeamMode(dir);

    const result = await handleNoteCreate(
      { content: "Team note.", title: "Team Note" },
      "json", dir,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.data.id).toMatch(/^n-[a-z0-9]{16}$/);
    expect(parsed.data.displayId).toBe("N-001");
    expect(parsed.data.createdAt).toEqual(expect.any(String));
    const raw = await readFile(join(dir, ".story", "notes", `${parsed.data.id}.json`), "utf-8");
    const note = JSON.parse(raw);
    expect(note.title).toBe("Team Note");
    await expect(readFile(join(dir, ".story", "notes", "N-001.json"), "utf-8")).rejects.toThrow();
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

  it("strips a whole-input 4+ backtick render fence from content and warns (ISS-1192)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const inner = "note line one\n```ts\ncode\n```\nline three";
    const rendered = `\`\`\`\`\n${inner}\n\`\`\`\``;
    const result = await handleNoteUpdate("N-001", { content: rendered }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.content).toBe(inner);
    expect(result.warnings).toEqual(["outer render fence removed; use --format json for round trips"]);
  });

  it("leaves a 3-backtick whole-content fence untouched, with no warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-update-"));
    tmpDirs.push(dir);
    await setupNote(dir);
    const input = "```\nhello\n```";
    const result = await handleNoteUpdate("N-001", { content: input }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.content).toBe(input);
    expect(result.warnings).toBeUndefined();
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

// --- ISS-1092: append mode and the destructive-replace guard ---

describe("handleNoteUpdate append mode and replace guard (ISS-1092)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const NOTE_FILE = (dir: string) => join(dir, ".story", "notes", "N-001.json");

  async function noteOf(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "note-guard-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleNoteCreate({ content, title: "Big", tags: ["alpha"] }, "md", dir);
    return dir;
  }

  async function stored(dir: string): Promise<{ content: string; title: string | null; status: string; tags: string[] }> {
    return JSON.parse(await readFile(NOTE_FILE(dir), "utf-8"));
  }

  async function refused(dir: string, updates: Parameters<typeof handleNoteUpdate>[1]): Promise<string> {
    const before = await readFile(NOTE_FILE(dir));
    const err = await handleNoteUpdate("N-001", updates, "json", dir).then(
      () => { throw new Error("expected a refusal"); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliValidationError);
    expect((err as CliValidationError).code).toBe("invalid_input");
    expect(await readFile(NOTE_FILE(dir))).toEqual(before);
    return (err as Error).message;
  }

  const chars = (n: number, fill = "x") => fill.repeat(n);

  it("A1: refuses a replace that shrinks a 5000-char note to 200, naming both lengths and both hatches, writing nothing", async () => {
    const dir = await noteOf(chars(5000, "o"));
    const message = await refused(dir, { content: chars(200, "n") });
    expect(message).toContain("5000");
    expect(message).toContain("200");
    expect(message).toContain("confirmReplace: true");
    expect(message).toContain('mode: "append"');
    expect(message).not.toContain("ooooo");
    expect(message).not.toContain("nnnnn");
  });

  it("A1b: a refused replace that also carries title, tags and status writes none of them", async () => {
    const dir = await noteOf(chars(5000));
    await refused(dir, { content: chars(200), title: "New", tags: ["beta"], status: "archived" });
  });

  it("A2: confirmReplace true replaces", async () => {
    const dir = await noteOf(chars(5000));
    await handleNoteUpdate("N-001", { content: chars(200, "n"), confirmReplace: true }, "json", dir);
    expect((await stored(dir)).content).toBe(chars(200, "n"));
  });

  it("A3: the floor and the ratio boundaries", async () => {
    const under = await noteOf(chars(999));
    await handleNoteUpdate("N-001", { content: "y" }, "json", under);
    expect((await stored(under)).content).toBe("y");

    const exact = await noteOf(chars(1000));
    await handleNoteUpdate("N-001", { content: chars(200, "y") }, "json", exact);
    expect((await stored(exact)).content).toBe(chars(200, "y"));

    const below = await noteOf(chars(1000));
    expect(await refused(below, { content: chars(199, "y") })).toContain("199");
  });

  it("A3: the guard measures content after the render fence is stripped", async () => {
    const dir = await noteOf(chars(1000));
    const fenced = `\`\`\`\`\n${chars(199, "y")}\n\`\`\`\``;
    expect(fenced.length).toBeGreaterThanOrEqual(200);
    expect(await refused(dir, { content: fenced })).toContain("199");
  });

  it("A4: a growing replace on a large note is unaffected", async () => {
    const dir = await noteOf(chars(5000));
    await handleNoteUpdate("N-001", { content: chars(6000, "g") }, "json", dir);
    expect((await stored(dir)).content).toBe(chars(6000, "g"));
  });

  it("A5: append stores exactly old, a blank line, then new", async () => {
    const dir = await noteOf("old body");
    await handleNoteUpdate("N-001", { content: "new part", mode: "append" }, "json", dir);
    expect((await stored(dir)).content).toBe("old body\n\nnew part");
  });

  it("A5: a fenced append is stripped first and carries the fence warning", async () => {
    const dir = await noteOf("old body");
    const result = await handleNoteUpdate("N-001", { content: "````\nnew part\n````", mode: "append" }, "json", dir);
    expect((await stored(dir)).content).toBe("old body\n\nnew part");
    expect(result.warnings).toEqual(["outer render fence removed; use --format json for round trips"]);
  });

  it("A5: a small append to a large note is never guarded", async () => {
    const dir = await noteOf(chars(5000));
    await handleNoteUpdate("N-001", { content: "z", mode: "append" }, "json", dir);
    expect((await stored(dir)).content).toBe(chars(5000) + "\n\nz");
  });

  it("A5: append rejects empty, whitespace-only, missing content and confirmReplace, writing nothing", async () => {
    const dir = await noteOf("old body");
    expect(await refused(dir, { content: "", mode: "append" })).toBe("Note content cannot be empty");
    expect(await refused(dir, { content: "  \n ", mode: "append" })).toBe("Note content cannot be empty");
    expect(await refused(dir, { mode: "append" })).toBe('mode applies to content: pass content with mode "append"');
    expect(await refused(dir, { content: "more", mode: "append", confirmReplace: true }))
      .toBe('confirmReplace does not apply to mode "append"');
  });

  it("D1: an explicit mode without content is the mode diagnostic, never 'No fields to update'", async () => {
    const dir = await noteOf("old body");
    expect(await refused(dir, { mode: "append", title: "x" })).toBe('mode applies to content: pass content with mode "append"');
    expect(await refused(dir, { mode: "replace", title: "x" })).toBe('mode applies to content: pass content with mode "replace"');
  });

  it("D2: confirmReplace alone is no update, and with a title only it changes nothing but the title", async () => {
    const dir = await noteOf(chars(5000));
    expect(await refused(dir, { confirmReplace: true })).toContain("No fields to update");
    await handleNoteUpdate("N-001", { title: "Renamed", confirmReplace: true }, "json", dir);
    const note = await stored(dir);
    expect(note.title).toBe("Renamed");
    expect(note.content).toBe(chars(5000));
  });

  it("A9/F3: title-only and status-only updates on a large note keep its content and never trip the guard", async () => {
    const dir = await noteOf(chars(5000));
    await handleNoteUpdate("N-001", { title: "Only title" }, "json", dir);
    expect((await stored(dir)).content).toBe(chars(5000));
    await handleNoteUpdate("N-001", { status: "archived" }, "json", dir);
    const note = await stored(dir);
    expect(note.status).toBe("archived");
    expect(note.content).toBe(chars(5000));
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
