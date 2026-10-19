/**
 * ISS-1404: two files claiming one canonical id are reported, one
 * `duplicate_id` warning per claiming file, and because that is an integrity
 * type every strict write refuses until the duplicate is resolved. What loads
 * does not change: both records stay and ProjectState indexes first-wins.
 *
 * The cases come from test/fixtures/duplicate-id-vectors.json, which the Mac
 * loader reads too, so the two sides cannot drift.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, duplicateIdMessage, withProjectLock } from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleReconcile } from "../../src/cli/commands/reconcile.js";
import { handleValidate } from "../../src/cli/commands/validate.js";
import { writeRulingUnlocked } from "../../src/core/ruling-loader.js";
import { makeLesson, makeNote, makeRuling } from "./test-factories.js";

interface VectorFile { readonly name: string; readonly id: string; readonly displayId?: string }
interface Vector {
  readonly name: string;
  readonly dir: "tickets" | "issues" | "notes" | "lessons";
  readonly files: readonly VectorFile[];
  readonly duplicates: readonly { readonly id: string; readonly files: readonly string[] }[];
  readonly writesRefused: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = (JSON.parse(readFileSync(join(here, "..", "fixtures", "duplicate-id-vectors.json"), "utf-8")) as { cases: Vector[] }).cases;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

const ticket = (id: string, title: string, order: number, displayId?: string) => ({
  id, ...(displayId ? { displayId } : {}), title, type: "task", status: "open", phase: "p1", order,
  description: "", createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
});
const issue = (id: string, title: string, order: number, displayId?: string) => ({
  id, ...(displayId ? { displayId } : {}), title, status: "open", severity: "medium", components: [], impact: "x",
  resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], order, phase: null,
});
const note = (id: string, title: string, _order: number, displayId?: string) => ({ ...makeNote({ id, title }), ...(displayId ? { displayId } : {}) });
const lesson = (id: string, title: string, _order: number, displayId?: string) => ({ ...makeLesson({ id, title }), ...(displayId ? { displayId } : {}) });
const RECORD = { tickets: ticket, issues: issue, notes: note, lessons: lesson } as const;

/** A team-mode project (reconcile needs it), with one directory holding `files`. */
function project(dir: Vector["dir"], files: readonly VectorFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "duplicate-id-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const d of ["tickets", "issues", "notes", "lessons"]) mkdirSync(join(story, d), { recursive: true });
  writeJson(join(story, "config.json"), {
    version: 2, schemaVersion: 2, project: "test", type: "app", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true }, team: { enabled: true },
  });
  writeJson(join(story, "roadmap.json"), { title: "Test", date: "2026-05-26", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }], blockers: [] });
  files.forEach((f, i) => {
    writeJson(join(story, dir, f.name), RECORD[dir](f.id, `${f.name} copy`, 10 * (i + 1), f.displayId));
  });
  return root;
}

function bytesOf(root: string, dir: string, files: readonly VectorFile[]): string[] {
  return files.map((f) => readFileSync(join(root, ".story", dir, f.name), "utf-8"));
}

describe("duplicate ids (ISS-1404)", () => {
  it("has vectors, so an emptied fixture fails loudly", () => {
    expect(VECTORS.length).toBeGreaterThan(0);
    // A duplicate case in every directory the loader reads by id.
    for (const dir of ["tickets", "issues", "notes", "lessons"]) {
      expect(VECTORS.some((v) => v.dir === dir && v.duplicates.length > 0), dir).toBe(true);
    }
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s: the warnings the vector names, and no others", async (_name, v) => {
    const root = project(v.dir, v.files);
    const { warnings, state } = await loadProject(root);
    const expected = v.duplicates.flatMap((d) =>
      d.files.map((file) => ({ file, type: "duplicate_id", message: duplicateIdMessage(d.id, v.dir, d.files) })),
    );
    expect(warnings.filter((w) => w.type === "duplicate_id")).toEqual(expected);
    // What loads is unchanged: every record stays in the arrays.
    const loaded = { tickets: state.tickets, issues: state.issues, notes: state.notes, lessons: state.lessons }[v.dir];
    expect(loaded).toHaveLength(v.files.length);
  });

  it("names every file in the message, sorted, with the recovery that does not rename", () => {
    expect(duplicateIdMessage("T-001", "tickets", [".story/tickets/T-001 copy.json", ".story/tickets/T-001.json"])).toBe(
      'Id "T-001" is claimed by 2 files: .story/tickets/T-001 copy.json, .story/tickets/T-001.json; only the first loads by id. ' +
        "Inspect each copy and keep what is intended: merge it into .story/tickets/T-001.json, then move the redundant copy out of .story/tickets/. " +
        "Renaming a file inside the directory does not resolve a duplicate.",
    );
  });

  it("first-wins by id is unchanged: the lexicographically first file's record holds the slot", async () => {
    const root = project("tickets", [{ name: "T-001.json", id: "T-001" }, { name: "T-001 copy.json", id: "T-001" }]);
    const { state } = await loadProject(root);
    expect(state.ticketByID("T-001")!.title).toBe("T-001 copy.json copy");
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s: a strict load refuses exactly when the vector says writes refuse", async (_name, v) => {
    const root = project(v.dir, v.files);
    const strict = loadProject(root, { strict: true });
    if (v.writesRefused) {
      await expect(strict).rejects.toThrow(ProjectLoaderError);
      await expect(loadProject(root, { strict: true })).rejects.toThrow(`Strict mode: ${v.duplicates[0]!.files[0]!}: `);
    } else {
      await expect(strict).resolves.toBeDefined();
    }
    await expect(loadProject(root)).resolves.toBeDefined();
  });

  it("a ticket update on a duplicated id refuses, and neither file changes", async () => {
    const files = [{ name: "T-001.json", id: "T-001" }, { name: "T-001 copy.json", id: "T-001" }];
    const root = project("tickets", files);
    const before = bytesOf(root, "tickets", files);
    // A handler may throw or return the refusal; either way it names the duplicate and writes nothing.
    const said = await handleTicketUpdate("T-001", { title: "Updated" }, "md", root).then(
      (r) => r.output,
      (err: unknown) => String(err),
    );
    expect(said).toContain("claimed by 2 files");
    expect(bytesOf(root, "tickets", files)).toEqual(before);
  });

  it("the strict lock itself refuses while a duplicate stands", async () => {
    const root = project("issues", [{ name: "ISS-001.json", id: "ISS-001" }, { name: "x.json", id: "ISS-001" }]);
    await expect(withProjectLock(root, { strict: true }, async () => {})).rejects.toThrow("claimed by 2 files");
  });

  it.each([
    ["two hash files sharing a display id", [{ name: "t-0000000000000001.json", id: "t-0000000000000001", displayId: "T-001" }, { name: "t-0000000000000002.json", id: "t-0000000000000002", displayId: "T-001" }]],
    ["a legacy and a hash file sharing a display id", [{ name: "T-001.json", id: "T-001" }, { name: "t-0000000000000002.json", id: "t-0000000000000002", displayId: "T-001" }]],
  ] as const)("%s is not a duplicate: strict load and reconcile both succeed", async (_name, files) => {
    const root = project("tickets", files);
    const { warnings } = await loadProject(root, { strict: true });
    expect(warnings.filter((w) => w.type === "duplicate_id")).toEqual([]);
    const result = await handleReconcile(root, { dryRun: false, ci: false, format: "md" });
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ["two ticket files with one id", "tickets", [{ name: "T-001.json", id: "T-001" }, { name: "T-001 copy.json", id: "T-001" }], true],
    ["two issue files with one id", "issues", [{ name: "ISS-001.json", id: "ISS-001" }, { name: "x.json", id: "ISS-001" }], true],
    ["a display-id collision (control)", "tickets", [{ name: "t-0000000000000001.json", id: "t-0000000000000001", displayId: "T-001" }, { name: "t-0000000000000002.json", id: "t-0000000000000002", displayId: "T-001" }], false],
  ] as const)("%s: validate reports ruling reachability unknown exactly when a record lost its slot", async (_name, dir, files, incomplete) => {
    const root = project(dir, files);
    await writeRulingUnlocked(makeRuling({ id: "r-0000000000000001" }), root);
    const { state, warnings } = await loadProject(root);
    const result = handleValidate({ state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" });
    if (incomplete) {
      expect(result.output).toContain("ruling_reachability_unknown");
      expect(result.output).not.toContain("unreachable_ruling");
    } else {
      expect(result.output).toContain("unreachable_ruling");
      expect(result.output).not.toContain("ruling_reachability_unknown");
    }
  });
});
