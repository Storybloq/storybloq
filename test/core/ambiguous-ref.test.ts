/**
 * ISS-1418: a ref that matches records sharing one canonical id (the ISS-1404
 * duplicate) names the claiming files and the recovery, in the loader's own
 * duplicate_id words, instead of listing the same id twice. Distinct ids keep
 * today's message byte for byte.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject, duplicateIdMessage } from "../../src/core/project-loader.js";
import {
  RefResolutionError,
  resolveAndNormalizeIssueRef,
  resolveAndNormalizeLessonRef,
  resolveAndNormalizeNoteRef,
  resolveAndNormalizeTicketRef,
  type RefDir,
} from "../../src/core/ref-normalization.js";
import { handleTicketGet } from "../../src/cli/commands/ticket.js";
import { handleIssueGet } from "../../src/cli/commands/issue.js";
import type { ProjectState } from "../../src/core/project-state.js";
import { makeLesson, makeNote, makeState, makeTicket } from "./test-factories.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

const RECORD: Record<RefDir, (id: string, displayId: string, title: string) => unknown> = {
  tickets: (id, displayId, title) => ({
    id, displayId, title, type: "task", status: "open", phase: "p1", order: 10,
    description: "", createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
  }),
  issues: (id, displayId, title) => ({
    id, displayId, title, status: "open", severity: "medium", components: [], impact: "x",
    resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], order: 10, phase: null,
  }),
  notes: (id, displayId, title) => ({ ...makeNote({ id, title }), displayId }),
  lessons: (id, displayId, title) => ({ ...makeLesson({ id, title }), displayId }),
};

/** A team-mode project with `files` (name -> [id, displayId]) in one directory. */
function project(dir: RefDir, files: Record<string, [string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "ambiguous-ref-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const d of ["tickets", "issues", "notes", "lessons"]) mkdirSync(join(story, d), { recursive: true });
  writeJson(join(story, "config.json"), {
    version: 2, schemaVersion: 2, project: "test", type: "app", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true }, team: { enabled: true },
  });
  writeJson(join(story, "roadmap.json"), { title: "Test", date: "2026-05-26", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }], blockers: [] });
  for (const [name, [id, displayId]] of Object.entries(files)) writeJson(join(story, dir, name), RECORD[dir](id, displayId, `${name} copy`));
  return root;
}

const RESOLVE: Record<RefDir, (state: ProjectState, ref: string) => string> = {
  tickets: resolveAndNormalizeTicketRef,
  issues: resolveAndNormalizeIssueRef,
  notes: resolveAndNormalizeNoteRef,
  lessons: resolveAndNormalizeLessonRef,
};

function refusal(run: () => unknown): RefResolutionError {
  try {
    run();
  } catch (err) {
    if (err instanceof RefResolutionError) return err;
    throw err;
  }
  throw new Error("expected the ref to be refused");
}

const CASES: readonly [RefDir, string, string][] = [
  ["tickets", "t-0000000000000001", "T-001"],
  ["issues", "i-0000000000000001", "ISS-001"],
  ["notes", "n-0000000000000001", "N-001"],
  ["lessons", "l-0000000000000001", "L-001"],
];

describe("an ambiguous ref over a duplicated id (ISS-1418)", () => {
  it.each(CASES)("%s: names both claiming files and the recovery, in the duplicate_id words", async (dir, id, display) => {
    const root = project(dir, { [`${id}.json`]: [id, display], [`${id} copy.json`]: [id, display] });
    const { state } = await loadProject(root);
    const err = refusal(() => RESOLVE[dir](state, display));
    expect(err.reason).toBe("ambiguous");
    const files = [`.story/${dir}/${id} copy.json`, `.story/${dir}/${id}.json`];
    expect(err.message).toBe(`Ref "${display}" is ambiguous: its 2 records share one id, ${id}. ${duplicateIdMessage(id, dir, files)}`);
    expect(err.message).not.toContain(`${id}, ${id}`);
  });

  it.each([
    ["ticket get", "tickets", "t-0000000000000001", "T-001"],
    ["issue get", "issues", "i-0000000000000001", "ISS-001"],
  ] as const)("the CLI's %s says the same", async (_name, dir, id, display) => {
    const root = project(dir, { [`${id}.json`]: [id, display], [`${id} copy.json`]: [id, display] });
    const { state, warnings } = await loadProject(root);
    const ctx = { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" as const };
    const result = await (dir === "tickets" ? handleTicketGet(display, ctx, false) : handleIssueGet(display, ctx, false));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(`is ambiguous: its 2 records share one id, ${id}.`);
    expect(result.output).toContain(`.story/${dir}/${id} copy.json, .story/${dir}/${id}.json`);
  });

  it("a state the loader did not build names the duplicate and points to validate", () => {
    const t = makeTicket({ id: "t-0000000000000001", displayId: "T-001" } as Parameters<typeof makeTicket>[0]);
    const state = makeState({ tickets: [t, { ...t, title: "copy" }] });
    expect(refusal(() => resolveAndNormalizeTicketRef(state, "T-001")).message).toBe(
      'Ref "T-001" is ambiguous: its 2 records share one id, t-0000000000000001. Run `storybloq validate` to list the files that claim it.',
    );
  });

  it("two distinct ids sharing a display id keep today's bytes", async () => {
    const root = project("tickets", {
      "t-0000000000000001.json": ["t-0000000000000001", "T-001"],
      "t-0000000000000002.json": ["t-0000000000000002", "T-001"],
    });
    const { state } = await loadProject(root);
    expect(refusal(() => resolveAndNormalizeTicketRef(state, "T-001")).message).toBe(
      'Ref "T-001" is ambiguous (matches: t-0000000000000001, t-0000000000000002)',
    );
  });
});
