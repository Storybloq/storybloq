/**
 * ISS-757 (TS half): team-mode soft-delete idempotency.
 *
 * Team mode: a second delete of an already-tombstoned item is a silent
 * success -- { alreadyDeleted: true }, NO write, original deletedAt/deletedBy
 * preserved byte-for-byte (the tombstone keeps the item addressable).
 *
 * Non-team mode: the file is physically unlinked, so a second delete throws
 * not_found. This asymmetry is deliberate and locked by these tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteTicket,
  deleteIssue,
  deleteNote,
  deleteLesson,
  type DeleteResult,
} from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { handleTicketDelete } from "../../src/cli/commands/ticket.js";
import { handleIssueDelete } from "../../src/cli/commands/issue.js";
import { handleNoteDelete } from "../../src/cli/commands/note.js";
import { handleLessonDelete } from "../../src/cli/commands/lesson.js";

// --- Fixtures ---

const baseConfig = {
  version: 2,
  schemaVersion: 3,
  project: "test",
  type: "npm",
  language: "typescript",
  features: {
    tickets: true,
    issues: true,
    handovers: true,
    roadmap: true,
    reviews: true,
  },
};

const teamConfig = { ...baseConfig, team: { enabled: true } };

const roadmap = {
  title: "test",
  date: "2026-01-01",
  phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Desc." }],
  blockers: [],
};

const ticket = {
  id: "T-001",
  title: "Test ticket",
  description: "A test.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-01-01",
  completedDate: null,
  blockedBy: [],
};

const issue = {
  id: "ISS-001",
  title: "Test issue",
  status: "open",
  severity: "medium",
  components: ["core"],
  impact: "Test impact.",
  resolution: null,
  location: ["file.ts:1"],
  discoveredDate: "2026-01-01",
  resolvedDate: null,
  relatedTickets: [],
};

const note = {
  id: "N-001",
  title: "Test note",
  content: "Note content.",
  tags: [],
  status: "active",
  createdDate: "2026-01-01",
  updatedDate: "2026-01-01",
};

const lesson = {
  id: "L-001",
  title: "Test lesson",
  content: "Lesson content.",
  context: "Lesson context.",
  tags: [],
  status: "active",
  source: "manual",
  reinforcements: 0,
  supersedes: null,
  createdDate: "2026-01-01",
  updatedDate: "2026-01-01",
  lastValidated: "2026-01-01",
};

let roots: string[] = [];

async function createProject(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "storybloq-softdel-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const dir of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    await mkdir(join(story, dir), { recursive: true });
  }
  await writeFile(join(story, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(story, "roadmap.json"), JSON.stringify(roadmap, null, 2));
  await writeFile(join(story, "tickets", "T-001.json"), JSON.stringify(ticket, null, 2));
  await writeFile(join(story, "issues", "ISS-001.json"), JSON.stringify(issue, null, 2));
  await writeFile(join(story, "notes", "N-001.json"), JSON.stringify(note, null, 2));
  await writeFile(join(story, "lessons", "L-001.json"), JSON.stringify(lesson, null, 2));
  return root;
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots = [];
});

type DeleteFn = (id: string, root: string, options?: { hard?: boolean; actor?: string; force?: boolean }) => Promise<DeleteResult>;

const entities: Array<{ kind: string; id: string; dir: string; del: DeleteFn }> = [
  { kind: "ticket", id: "T-001", dir: "tickets", del: deleteTicket },
  { kind: "issue", id: "ISS-001", dir: "issues", del: deleteIssue },
  { kind: "note", id: "N-001", dir: "notes", del: deleteNote },
  { kind: "lesson", id: "L-001", dir: "lessons", del: deleteLesson },
];

describe("ISS-757: team-mode soft-delete idempotency", () => {
  for (const { kind, id, dir, del } of entities) {
    it(`${kind}: first delete tombstones and returns alreadyDeleted false`, async () => {
      const root = await createProject(teamConfig);
      const result = await del(id, root, { actor: "alice@example.com" });
      expect(result.alreadyDeleted).toBe(false);
      const raw = JSON.parse(await readFile(join(root, ".story", dir, `${id}.json`), "utf-8"));
      expect(raw.lifecycle).toBe("deleted");
      expect(raw.deletedBy).toBe("alice@example.com");
      expect(typeof raw.deletedAt).toBe("string");
    });

    it(`${kind}: second delete is a silent success that preserves the tombstone byte-for-byte`, async () => {
      const root = await createProject(teamConfig);
      const filePath = join(root, ".story", dir, `${id}.json`);
      await del(id, root, { actor: "alice@example.com" });
      const bytesAfterFirst = await readFile(filePath, "utf-8");
      const firstTombstone = JSON.parse(bytesAfterFirst);

      // Re-delete as a DIFFERENT actor: no write may occur.
      const second = await del(id, root, { actor: "mallory@example.com" });
      expect(second.alreadyDeleted).toBe(true);

      const bytesAfterSecond = await readFile(filePath, "utf-8");
      expect(bytesAfterSecond).toBe(bytesAfterFirst);
      const secondTombstone = JSON.parse(bytesAfterSecond);
      expect(secondTombstone.deletedBy).toBe(firstTombstone.deletedBy);
      expect(secondTombstone.deletedAt).toBe(firstTombstone.deletedAt);
    });

    it(`${kind}: non-team second delete throws not_found (deliberate asymmetry)`, async () => {
      const root = await createProject(baseConfig);
      const first = await del(id, root);
      expect(first.alreadyDeleted).toBe(false);
      try {
        await del(id, root);
        expect.fail("Should have thrown not_found");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectLoaderError);
        expect((err as ProjectLoaderError).code).toBe("not_found");
      }
    });
  }
});

describe("ISS-757: CLI delete handlers surface alreadyDeleted", () => {
  it("ticket: second delete reports already deleted (text) without throwing", async () => {
    const root = await createProject(teamConfig);
    await handleTicketDelete("T-001", false, "md", root);
    const result = await handleTicketDelete("T-001", false, "md", root);
    expect(result.output).toContain("already deleted");
    expect(result.output).toContain("tombstone preserved");
  });

  it("ticket: second delete JSON envelope gains alreadyDeleted true", async () => {
    const root = await createProject(teamConfig);
    const first = await handleTicketDelete("T-001", false, "json", root);
    expect(JSON.parse(first.output!).data.alreadyDeleted).toBeUndefined();
    const second = await handleTicketDelete("T-001", false, "json", root);
    const parsed = JSON.parse(second.output!);
    expect(parsed.data.alreadyDeleted).toBe(true);
    expect(parsed.data.deleted).toBe(true);
  });

  it("issue: second delete reports already deleted in text and JSON", async () => {
    const root = await createProject(teamConfig);
    await handleIssueDelete("ISS-001", "md", root);
    const text = await handleIssueDelete("ISS-001", "md", root);
    expect(text.output).toContain("already deleted");
    const json = await handleIssueDelete("ISS-001", "json", root);
    expect(JSON.parse(json.output!).data.alreadyDeleted).toBe(true);
  });

  it("note: second delete reports already deleted in text and JSON", async () => {
    const root = await createProject(teamConfig);
    await handleNoteDelete("N-001", "md", root);
    const text = await handleNoteDelete("N-001", "md", root);
    expect(text.output).toContain("already deleted");
    const json = await handleNoteDelete("N-001", "json", root);
    expect(JSON.parse(json.output!).data.alreadyDeleted).toBe(true);
  });

  it("lesson: second delete reports already deleted in text and JSON", async () => {
    const root = await createProject(teamConfig);
    await handleLessonDelete("L-001", "md", root);
    const text = await handleLessonDelete("L-001", "md", root);
    expect(text.output).toContain("already deleted");
    const json = await handleLessonDelete("L-001", "json", root);
    expect(JSON.parse(json.output!).data.alreadyDeleted).toBe(true);
  });
});

// T-481 B3: a soft delete adds exactly the tombstone fields, never updatedDate.
// merge-driver.ts hasNonTombstoneChanges treats any other changed field as an
// edit, so a stamped tombstone would merge as a delete-edit conflict (ISS-727).
describe("T-481 B3: a tombstone adds only lifecycle, deletedAt and deletedBy", () => {
  for (const e of entities.filter((x) => x.kind === "ticket" || x.kind === "issue")) {
    it(`${e.kind}: the delete adds exactly the tombstone keys and leaves updatedDate alone`, async () => {
      const root = await createProject(teamConfig);
      const path = join(root, ".story", e.dir, `${e.id}.json`);
      const prior = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
      prior.updatedDate = "2020-01-01";
      await writeFile(path, JSON.stringify(prior, null, 2));
      await e.del(e.id, root, { actor: "t481@test" });
      const after = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
      const added = Object.keys(after).filter((k) => !(k in prior)).sort();
      expect(added).toEqual(["deletedAt", "deletedBy", "lifecycle"]);
      const changed = Object.keys(prior).filter((k) => JSON.stringify(prior[k]) !== JSON.stringify(after[k]));
      expect(changed).toEqual([]);
      expect(after.updatedDate).toBe("2020-01-01");
    });
  }
});
