import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleLessonList,
  handleLessonGet,
  handleLessonDigest,
  handleLessonCreate,
  handleLessonUpdate,
  handleLessonReinforce,
  handleLessonDelete,
} from "../../../src/cli/commands/lesson.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState, makeLesson } from "../../core/test-factories.js";
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

describe("handleLessonList", () => {
  it("returns all lessons with no filters", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [
          makeLesson({ id: "L-001", title: "Lesson A" }),
          makeLesson({ id: "L-002", title: "Lesson B" }),
        ],
      }),
    });
    const result = handleLessonList({}, ctx);
    expect(result.output).toContain("L-001");
    expect(result.output).toContain("L-002");
  });

  it("filters by status", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [
          makeLesson({ id: "L-001", status: "active" }),
          makeLesson({ id: "L-002", status: "deprecated" }),
        ],
      }),
    });
    const result = handleLessonList({ status: "active" }, ctx);
    expect(result.output).toContain("L-001");
    expect(result.output).not.toContain("L-002");
  });

  it("filters by source", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [
          makeLesson({ id: "L-001", source: "review" }),
          makeLesson({ id: "L-002", source: "manual" }),
        ],
      }),
    });
    const result = handleLessonList({ source: "review" }, ctx);
    expect(result.output).toContain("L-001");
    expect(result.output).not.toContain("L-002");
  });

  it("filters by tag", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [
          makeLesson({ id: "L-001", tags: ["process"] }),
          makeLesson({ id: "L-002", tags: ["architecture"] }),
        ],
      }),
    });
    const result = handleLessonList({ tag: "process" }, ctx);
    expect(result.output).toContain("L-001");
    expect(result.output).not.toContain("L-002");
  });

  it("returns empty message when no lessons", () => {
    const ctx = makeCtx();
    const result = handleLessonList({}, ctx);
    expect(result.output).toContain("No lessons");
  });

  it("sorts by reinforcements desc", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [
          makeLesson({ id: "L-001", reinforcements: 1 }),
          makeLesson({ id: "L-002", reinforcements: 5 }),
        ],
      }),
      format: "json",
    });
    const result = handleLessonList({}, ctx);
    const parsed = JSON.parse(result.output);
    const ids = parsed.data.map((l: { id: string }) => l.id);
    expect(ids[0]).toBe("L-002");
  });

  it("rejects invalid status", () => {
    const ctx = makeCtx();
    expect(() => handleLessonList({ status: "archived" }, ctx)).toThrow();
  });

  it("rejects invalid source", () => {
    const ctx = makeCtx();
    expect(() => handleLessonList({ source: "ai" }, ctx)).toThrow();
  });
});

// --- Get ---

describe("handleLessonGet", () => {
  it("returns lesson when found", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [makeLesson({ id: "L-001", title: "My Lesson" })],
      }),
    });
    const result = handleLessonGet("L-001", ctx);
    expect(result.output).toContain("My Lesson");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns not_found when missing", () => {
    const ctx = makeCtx();
    const result = handleLessonGet("L-999", ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });
});

// --- Digest ---

describe("handleLessonDigest", () => {
  it("returns digest when lessons exist", () => {
    const ctx = makeCtx({
      state: makeState({
        lessons: [makeLesson({ id: "L-001", title: "Always review" })],
      }),
    });
    const result = handleLessonDigest(ctx);
    expect(result.output).toContain("Lessons Learned");
    expect(result.output).toContain("Always review");
  });

  it("returns empty message when no lessons", () => {
    const ctx = makeCtx();
    const result = handleLessonDigest(ctx);
    expect(result.output).toContain("No active lessons");
  });
});

// --- Create ---

describe("handleLessonCreate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("creates a lesson with required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleLessonCreate(
      { title: "Test lesson", content: "Always test.", context: "T-133", source: "manual" },
      "md", dir,
    );
    expect(result.output).toContain("Created lesson L-001");
    const raw = await readFile(join(dir, ".story", "lessons", "L-001.json"), "utf-8");
    const lesson = JSON.parse(raw);
    expect(lesson.title).toBe("Test lesson");
    expect(lesson.content).toBe("Always test.");
    expect(lesson.source).toBe("manual");
    expect(lesson.status).toBe("active");
    expect(lesson.reinforcements).toBe(0);
    expect(lesson.supersedes).toBeNull();
  });

  it("creates sequential IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleLessonCreate(
      { title: "First", content: "First lesson.", context: "T-001", source: "manual" },
      "md", dir,
    );
    const result = await handleLessonCreate(
      { title: "Second", content: "Second lesson.", context: "T-002", source: "review" },
      "md", dir,
    );
    expect(result.output).toContain("Created lesson L-002");
  });

  it("rejects empty title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleLessonCreate({ title: "", content: "X", context: "Y", source: "manual" }, "md", dir),
    ).rejects.toThrow();
  });

  it("rejects empty content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleLessonCreate({ title: "X", content: "", context: "Y", source: "manual" }, "md", dir),
    ).rejects.toThrow();
  });

  it("rejects invalid source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-create-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleLessonCreate({ title: "X", content: "Y", context: "Z", source: "ai" }, "md", dir),
    ).rejects.toThrow();
  });
});

// --- Update ---

describe("handleLessonUpdate", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupLesson(dir: string) {
    await initProject(dir, { name: "test" });
    await handleLessonCreate(
      { title: "Original", content: "Original content.", context: "T-001", source: "manual", tags: ["alpha"] },
      "md", dir,
    );
  }

  it("updates content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-update-"));
    tmpDirs.push(dir);
    await setupLesson(dir);
    const result = await handleLessonUpdate("L-001", { content: "Updated." }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.content).toBe("Updated.");
  });

  it("updates status to deprecated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-update-"));
    tmpDirs.push(dir);
    await setupLesson(dir);
    const result = await handleLessonUpdate("L-001", { status: "deprecated" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.status).toBe("deprecated");
  });

  it("updates tags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-update-"));
    tmpDirs.push(dir);
    await setupLesson(dir);
    const result = await handleLessonUpdate("L-001", { tags: ["beta", "gamma"] }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.tags).toEqual(["beta", "gamma"]);
  });

  it("returns not_found for missing lesson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-update-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleLessonUpdate("L-999", { content: "X" }, "md", dir),
    ).rejects.toThrow("not found");
  });
});

// --- Reinforce ---

describe("handleLessonReinforce", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("increments reinforcement count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-reinforce-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleLessonCreate(
      { title: "Test", content: "Test.", context: "T-001", source: "manual" },
      "md", dir,
    );
    const result = await handleLessonReinforce("L-001", "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.reinforcements).toBe(1);
    // Second reinforce
    const result2 = await handleLessonReinforce("L-001", "json", dir);
    const parsed2 = JSON.parse(result2.output);
    expect(parsed2.data.reinforcements).toBe(2);
  });

  it("returns not_found for missing lesson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-reinforce-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleLessonReinforce("L-999", "md", dir),
    ).rejects.toThrow("not found");
  });
});

// --- Delete ---

describe("handleLessonDelete", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("deletes a lesson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleLessonCreate(
      { title: "Doomed", content: "Gone.", context: "T-001", source: "manual" },
      "md", dir,
    );
    const result = await handleLessonDelete("L-001", "md", dir);
    expect(result.output).toContain("Deleted lesson L-001");
  });

  it("blocks delete when referenced by supersedes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleLessonCreate(
      { title: "Original", content: "Old.", context: "T-001", source: "manual" },
      "md", dir,
    );
    await handleLessonCreate(
      { title: "Replacement", content: "New.", context: "T-002", source: "manual", supersedes: "L-001" },
      "md", dir,
    );
    await expect(
      handleLessonDelete("L-001", "md", dir),
    ).rejects.toThrow("referenced");
  });

  it("throws for missing lesson", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lesson-delete-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleLessonDelete("L-999", "md", dir),
    ).rejects.toThrow();
  });
});
