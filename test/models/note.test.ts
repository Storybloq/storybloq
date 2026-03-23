import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fixturesDir, readJson } from "../helpers.js";
import { NoteSchema } from "../../src/models/note.js";

describe("NoteSchema", () => {
  describe("valid notes", () => {
    it("parses an active note with all fields", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/notes/N-001.json"));
      const result = NoteSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("N-001");
        expect(result.data.title).toBe("Architecture brainstorm");
        expect(result.data.content).toBe("Ideas for service layer refactoring.");
        expect(result.data.tags).toEqual(["architecture", "design"]);
        expect(result.data.status).toBe("active");
        expect(result.data.createdDate).toBe("2026-03-20");
        expect(result.data.updatedDate).toBe("2026-03-21");
      }
    });

    it("parses a note with null title", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/notes/N-002.json"));
      const result = NoteSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBeNull();
        expect(result.data.content).toBe("Possible future features: search, export, analytics.");
      }
    });

    it("parses all valid fixture notes", () => {
      for (const file of ["N-001.json", "N-002.json"]) {
        const data = readJson(resolve(fixturesDir, `valid/basic/notes/${file}`));
        expect(NoteSchema.safeParse(data).success, `Failed to parse ${file}`).toBe(true);
      }
    });

    it("accepts tags as-is without transformation", () => {
      const data = {
        id: "N-010", title: null, content: "Pre-normalized tags.",
        tags: ["foo", "bar", "hello-world"], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      const result = NoteSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toEqual(["foo", "bar", "hello-world"]);
      }
    });

    it("accepts valid tags array", () => {
      const data = {
        id: "N-010", title: "Tags test", content: "Some content.",
        tags: ["foo", "bar", "baz"], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      const result = NoteSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toEqual(["foo", "bar", "baz"]);
      }
    });
  });

  describe("invalid notes", () => {
    it("rejects missing title field", () => {
      const data = {
        id: "N-010", content: "No title key at all.",
        tags: [], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects missing tags field", () => {
      const data = {
        id: "N-010", title: null, content: "No tags key.",
        status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects null tags", () => {
      const data = {
        id: "N-010", title: null, content: "Null tags.",
        tags: null, status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects empty content after trim", () => {
      const data = {
        id: "N-010", title: "Empty", content: "",
        tags: [], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects whitespace-only content after trim", () => {
      const data = {
        id: "N-010", title: "Spaces", content: "   \n\t  ",
        tags: [], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects invalid ID format", () => {
      const data = {
        id: "NOTE-001", title: "Bad ID", content: "Some content.",
        tags: [], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects invalid status", () => {
      const data = {
        id: "N-010", title: "Bad status", content: "Some content.",
        tags: [], status: "deleted",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });

    it("rejects invalid date format", () => {
      const data = {
        id: "N-010", title: "Bad date", content: "Some content.",
        tags: [], status: "active",
        createdDate: "March 20, 2026", updatedDate: "2026-03-20",
      };
      expect(NoteSchema.safeParse(data).success).toBe(false);
    });
  });

  describe("round-trip unknown key preservation", () => {
    it("preserves unknown extra keys through parse and serialize", () => {
      const data = {
        id: "N-050", title: "Note with extras", content: "Extra fields test.",
        tags: ["test"], status: "active",
        createdDate: "2026-03-20", updatedDate: "2026-03-20",
        extraField: "preserved", extraNumber: 42,
      };
      const result = NoteSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.extraField).toBe("preserved");
        expect(result.data.extraNumber).toBe(42);

        const serialized = JSON.parse(JSON.stringify(result.data));
        const reparsed = NoteSchema.safeParse(serialized);
        expect(reparsed.success).toBe(true);
        if (reparsed.success) {
          expect(reparsed.data.extraField).toBe("preserved");
        }
      }
    });
  });
});
