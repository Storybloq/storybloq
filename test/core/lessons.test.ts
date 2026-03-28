import { describe, it, expect } from "vitest";
import { buildLessonDigest } from "../../src/core/lessons.js";
import { makeLesson } from "./test-factories.js";

describe("buildLessonDigest", () => {
  it("returns empty string for no lessons", () => {
    expect(buildLessonDigest([])).toBe("");
  });

  it("returns empty string when all lessons are non-active", () => {
    const lessons = [
      makeLesson({ id: "L-001", status: "deprecated" }),
      makeLesson({ id: "L-002", status: "superseded" }),
    ];
    expect(buildLessonDigest(lessons)).toBe("");
  });

  it("includes active lessons in output", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Always review", content: "Multi-round reviews." }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("# Lessons Learned");
    expect(result).toContain("**Always review**");
    expect(result).toContain("Multi-round reviews.");
  });

  it("excludes non-active lessons", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Active one", status: "active" }),
      makeLesson({ id: "L-002", title: "Deprecated one", status: "deprecated" }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("Active one");
    expect(result).not.toContain("Deprecated one");
  });

  it("sorts by reinforcements descending", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Low", reinforcements: 1, tags: ["process"] }),
      makeLesson({ id: "L-002", title: "High", reinforcements: 5, tags: ["process"] }),
    ];
    const result = buildLessonDigest(lessons);
    const highIdx = result.indexOf("**High**");
    const lowIdx = result.indexOf("**Low**");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("groups by first tag", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Review lesson", tags: ["review"] }),
      makeLesson({ id: "L-002", title: "Process lesson", tags: ["process"] }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("## review");
    expect(result).toContain("## process");
  });

  it("uses 'general' group for tagless lessons", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "No tags", tags: [] }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("## general");
  });

  it("shows reinforcement count for reinforced lessons", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Reinforced", reinforcements: 3 }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("(×3)");
  });

  it("does not show reinforcement count for zero reinforcements", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Fresh", reinforcements: 0 }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).not.toContain("(×");
  });

  it("starts with # heading (H1) — callers downgrade for context digest", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Test" }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toMatch(/^# Lessons Learned/);
    // Context digest in guide.ts applies .replace(/^# /m, "## ") to downgrade to H2
    const downgraded = result.replace(/^# /m, "## ");
    expect(downgraded).toMatch(/^## Lessons Learned/);
    expect(downgraded).not.toMatch(/^# /m); // no remaining H1
  });
});
