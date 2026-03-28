import { describe, it, expect } from "vitest";
import { LessonSchema } from "../../src/models/lesson.js";

const validLesson = {
  id: "L-001",
  title: "Multi-round reviews catch different bugs",
  content: "Always use mixed reviewers. Round 1 finds architecture issues.",
  context: "T-035/T-036: 12 issues in round 1, 0 in round 2, consistent across batches.",
  source: "review",
  tags: ["review", "process"],
  reinforcements: 3,
  lastValidated: "2026-03-27",
  createdDate: "2026-03-11",
  updatedDate: "2026-03-27",
  supersedes: null,
  status: "active",
};

describe("LessonSchema", () => {
  describe("valid lessons", () => {
    it("parses a fully populated lesson", () => {
      const result = LessonSchema.safeParse(validLesson);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("L-001");
        expect(result.data.title).toBe("Multi-round reviews catch different bugs");
        expect(result.data.source).toBe("review");
        expect(result.data.reinforcements).toBe(3);
        expect(result.data.supersedes).toBeNull();
        expect(result.data.status).toBe("active");
      }
    });

    it("accepts all valid statuses", () => {
      for (const status of ["active", "deprecated", "superseded"]) {
        const result = LessonSchema.safeParse({ ...validLesson, status });
        expect(result.success, `Failed for status: ${status}`).toBe(true);
      }
    });

    it("accepts all valid sources", () => {
      for (const source of ["review", "correction", "postmortem", "manual"]) {
        const result = LessonSchema.safeParse({ ...validLesson, source });
        expect(result.success, `Failed for source: ${source}`).toBe(true);
      }
    });

    it("accepts supersedes with valid lesson ID", () => {
      const result = LessonSchema.safeParse({ ...validLesson, supersedes: "L-005" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.supersedes).toBe("L-005");
      }
    });

    it("accepts zero reinforcements", () => {
      const result = LessonSchema.safeParse({ ...validLesson, reinforcements: 0 });
      expect(result.success).toBe(true);
    });
  });

  describe("invalid lessons", () => {
    it("rejects empty title", () => {
      expect(LessonSchema.safeParse({ ...validLesson, title: "" }).success).toBe(false);
    });

    it("rejects empty content", () => {
      expect(LessonSchema.safeParse({ ...validLesson, content: "" }).success).toBe(false);
    });

    it("rejects whitespace-only content", () => {
      expect(LessonSchema.safeParse({ ...validLesson, content: "   \n\t  " }).success).toBe(false);
    });

    it("rejects invalid ID format", () => {
      expect(LessonSchema.safeParse({ ...validLesson, id: "LESSON-001" }).success).toBe(false);
    });

    it("rejects invalid status", () => {
      expect(LessonSchema.safeParse({ ...validLesson, status: "archived" }).success).toBe(false);
    });

    it("rejects invalid source", () => {
      expect(LessonSchema.safeParse({ ...validLesson, source: "ai" }).success).toBe(false);
    });

    it("rejects negative reinforcements", () => {
      expect(LessonSchema.safeParse({ ...validLesson, reinforcements: -1 }).success).toBe(false);
    });

    it("rejects non-integer reinforcements", () => {
      expect(LessonSchema.safeParse({ ...validLesson, reinforcements: 1.5 }).success).toBe(false);
    });

    it("rejects invalid supersedes format", () => {
      expect(LessonSchema.safeParse({ ...validLesson, supersedes: "T-001" }).success).toBe(false);
    });

    it("rejects invalid date format", () => {
      expect(LessonSchema.safeParse({ ...validLesson, createdDate: "March 27" }).success).toBe(false);
    });

    it("rejects missing required fields", () => {
      const { title: _, ...noTitle } = validLesson;
      expect(LessonSchema.safeParse(noTitle).success).toBe(false);
    });
  });

  describe("round-trip unknown key preservation", () => {
    it("preserves unknown extra keys through parse and serialize", () => {
      const data = { ...validLesson, extraField: "preserved", extraNumber: 42 };
      const result = LessonSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.extraField).toBe("preserved");
        const serialized = JSON.parse(JSON.stringify(result.data));
        const reparsed = LessonSchema.safeParse(serialized);
        expect(reparsed.success).toBe(true);
        if (reparsed.success) {
          expect(reparsed.data.extraField).toBe("preserved");
        }
      }
    });
  });
});
