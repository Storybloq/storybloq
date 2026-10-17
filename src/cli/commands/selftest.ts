import {
  loadProject,
  withProjectLock,
  writeTicketUnlocked,
  writeIssueUnlocked,
  writeNoteUnlocked,
  writeLessonUnlocked,
  writeTicket,
  writeIssue,
  writeNote,
  writeLesson,
  deleteTicket,
  deleteIssue,
  deleteNote,
  deleteLesson,
} from "../../core/project-loader.js";
import {
  nextTicketID,
  nextIssueID,
  nextNoteID,
  nextLessonID,
  allocateTeamTicketId,
  allocateTeamIssueId,
  allocateTeamNoteId,
  allocateTeamLessonId,
} from "../../core/id-allocation.js";
import { formatSelftestResult } from "../../core/output-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";
import type { Note } from "../../models/note.js";
import type { Lesson } from "../../models/lesson.js";
import type { CommandResult } from "../types.js";
import { todayISO } from "../helpers.js";
import { localDateOf } from "../../core/local-date.js";

export interface SelftestCheckResult {
  readonly entity: "ticket" | "issue" | "note" | "lesson";
  readonly step: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SelftestResult {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly results: readonly SelftestCheckResult[];
  readonly cleanupErrors: readonly string[];
  readonly warnings: readonly string[];
}

async function codexInstallationWarnings(): Promise<string[]> {
  if (process.env.STORYBLOQ_CLIENT !== "codex") return [];
  try {
    const { countCodexStorybloqHooks } = await import("./setup-skill.js");
    const counts = await countCodexStorybloqHooks();
    const installed = Object.entries(counts).filter(([, count]) => count > 0).map(([type]) => type);
    if (installed.length === 0) {
      return ["Codex Storybloq hooks are not installed. Run `storybloq setup --client codex`, then review `/hooks`."];
    }
    if (installed.length < 3) {
      return [`Codex Storybloq hooks are partially installed (${installed.join(", ")}). Re-run setup, then review /hooks.`];
    }
    return ["Codex Storybloq hooks are installed; trust is unknown. Open `/hooks` in Codex to review and trust them."];
  } catch (err) {
    return [`Could not inspect Codex hooks: ${errMsg(err)}`];
  }
}

/**
 * Integration smoke test: create/update/verify/delete cycle across all entity types.
 *
 * @param failAfter - Test-only: throw after N successful checks to test cleanup. Omit in production.
 */
export async function handleSelftest(
  root: string,
  format: OutputFormat,
  failAfter?: number,
): Promise<CommandResult> {
  const results: SelftestCheckResult[] = [];
  const createdIds: { type: "ticket" | "issue" | "note" | "lesson"; id: string }[] = [];
  const cleanupErrors: string[] = [];

  function record(entity: "ticket" | "issue" | "note" | "lesson", step: string, passed: boolean, detail: string): void {
    results.push({ entity, step, passed, detail });
    if (failAfter !== undefined && results.filter((r) => r.passed).length >= failAfter) {
      throw new Error(`failAfter(${failAfter}): induced failure for testing`);
    }
  }

  try {
    // --- Ticket cycle ---
    let ticketId: string | undefined;
    try {
      await withProjectLock(root, { strict: false }, async (result) => {
        const isTeam = result.state.config.team?.enabled === true;
        let displayId: string | undefined;
        if (isTeam) {
          const alloc = allocateTeamTicketId(result.state.tickets);
          ticketId = alloc.id;
          displayId = alloc.displayId;
        } else {
          ticketId = nextTicketID(result.state.tickets);
        }
        const instant = new Date();
        const createdAt = instant.toISOString();
        const today = localDateOf(instant);
        const ticket: Ticket = {
          id: ticketId,
          ...(displayId != null && { displayId }),
          title: "selftest ticket",
          type: "chore",
          status: "open",
          phase: null,
          order: 0,
          description: "Integration smoke test -- will be deleted.",
          createdDate: today,
          ...(isTeam && { createdAt }),
          completedDate: null,
          blockedBy: [],
          parentTicket: null,
        };
        await writeTicketUnlocked(ticket, root, { createOnly: true });
      });
      createdIds.push({ type: "ticket", id: ticketId! });
      record("ticket", "create", true, `Created ${ticketId}`);
    } catch (err) {
      record("ticket", "create", false, errMsg(err));
    }

    if (ticketId) {
      try {
        const { state } = await loadProject(root);
        const found = state.ticketByID(ticketId);
        if (!found) throw new Error(`${ticketId} not found after create`);
        record("ticket", "get", true, `Found ${ticketId}`);
      } catch (err) {
        record("ticket", "get", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const existing = state.ticketByID(ticketId);
        if (!existing) throw new Error(`${ticketId} not found for update`);
        const updated: Ticket = { ...existing, status: "inprogress" };
        await writeTicket(updated, root);
        record("ticket", "update", true, `Updated ${ticketId} status → inprogress`);
      } catch (err) {
        record("ticket", "update", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.ticketByID(ticketId);
        if (!found) throw new Error(`${ticketId} not found for verify`);
        if (found.status !== "inprogress") throw new Error(`Expected inprogress, got ${found.status}`);
        record("ticket", "verify update", true, `Verified ${ticketId} status = inprogress`);
      } catch (err) {
        record("ticket", "verify update", false, errMsg(err));
      }

      try {
        await deleteTicket(ticketId, root, { force: true, hard: true });
        createdIds.splice(createdIds.findIndex((c) => c.id === ticketId), 1);
        record("ticket", "delete", true, `Deleted ${ticketId}`);
      } catch (err) {
        record("ticket", "delete", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.ticketByID(ticketId);
        if (found) throw new Error(`${ticketId} still exists after delete`);
        record("ticket", "verify delete", true, `Confirmed ${ticketId} absent`);
      } catch (err) {
        record("ticket", "verify delete", false, errMsg(err));
      }
    }

    // --- Issue cycle ---
    let issueId: string | undefined;
    try {
      await withProjectLock(root, { strict: false }, async (result) => {
        const isTeam = result.state.config.team?.enabled === true;
        let displayId: string | undefined;
        if (isTeam) {
          const alloc = allocateTeamIssueId(result.state.issues);
          issueId = alloc.id;
          displayId = alloc.displayId;
        } else {
          issueId = nextIssueID(result.state.issues);
        }
        const instant = new Date();
        const createdAt = instant.toISOString();
        const today = localDateOf(instant);
        const issue: Issue = {
          id: issueId,
          ...(displayId != null && { displayId }),
          title: "selftest issue",
          status: "open",
          severity: "low",
          components: [],
          impact: "Integration smoke test -- will be deleted.",
          resolution: null,
          location: [],
          discoveredDate: today,
          ...(isTeam && { createdAt }),
          resolvedDate: null,
          relatedTickets: [],
          order: 0,
          phase: null,
        };
        await writeIssueUnlocked(issue, root, { createOnly: true });
      });
      createdIds.push({ type: "issue", id: issueId! });
      record("issue", "create", true, `Created ${issueId}`);
    } catch (err) {
      record("issue", "create", false, errMsg(err));
    }

    if (issueId) {
      try {
        const { state } = await loadProject(root);
        const found = state.issueByID(issueId);
        if (!found) throw new Error(`${issueId} not found after create`);
        record("issue", "get", true, `Found ${issueId}`);
      } catch (err) {
        record("issue", "get", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const existing = state.issueByID(issueId);
        if (!existing) throw new Error(`${issueId} not found for update`);
        const updated: Issue = { ...existing, status: "inprogress" };
        await writeIssue(updated, root);
        record("issue", "update", true, `Updated ${issueId} status → inprogress`);
      } catch (err) {
        record("issue", "update", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.issueByID(issueId);
        if (!found) throw new Error(`${issueId} not found for verify`);
        if (found.status !== "inprogress") throw new Error(`Expected inprogress, got ${found.status}`);
        record("issue", "verify update", true, `Verified ${issueId} status = inprogress`);
      } catch (err) {
        record("issue", "verify update", false, errMsg(err));
      }

      try {
        await deleteIssue(issueId, root, { hard: true });
        createdIds.splice(createdIds.findIndex((c) => c.id === issueId), 1);
        record("issue", "delete", true, `Deleted ${issueId}`);
      } catch (err) {
        record("issue", "delete", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.issueByID(issueId);
        if (found) throw new Error(`${issueId} still exists after delete`);
        record("issue", "verify delete", true, `Confirmed ${issueId} absent`);
      } catch (err) {
        record("issue", "verify delete", false, errMsg(err));
      }
    }

    // --- Note cycle ---
    let noteId: string | undefined;
    try {
      await withProjectLock(root, { strict: false }, async (result) => {
        const isTeam = result.state.config.team?.enabled === true;
        let displayId: string | undefined;
        if (isTeam) {
          const alloc = allocateTeamNoteId(result.state.notes);
          noteId = alloc.id;
          displayId = alloc.displayId;
        } else {
          noteId = nextNoteID(result.state.notes);
        }
        const instant = new Date();
        const createdAt = instant.toISOString();
        const today = localDateOf(instant);
        const note: Note = {
          id: noteId,
          ...(displayId != null && { displayId }),
          title: "selftest note",
          content: "Integration smoke test -- will be deleted.",
          tags: [],
          status: "active",
          createdDate: today,
          ...(isTeam && { createdAt }),
          updatedDate: today,
        };
        await writeNoteUnlocked(note, root, { createOnly: true });
      });
      createdIds.push({ type: "note", id: noteId! });
      record("note", "create", true, `Created ${noteId}`);
    } catch (err) {
      record("note", "create", false, errMsg(err));
    }

    if (noteId) {
      try {
        const { state } = await loadProject(root);
        const found = state.noteByID(noteId);
        if (!found) throw new Error(`${noteId} not found after create`);
        record("note", "get", true, `Found ${noteId}`);
      } catch (err) {
        record("note", "get", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const existing = state.noteByID(noteId);
        if (!existing) throw new Error(`${noteId} not found for update`);
        const updated: Note = { ...existing, status: "archived", updatedDate: todayISO() };
        await writeNote(updated, root);
        record("note", "update", true, `Updated ${noteId} status → archived`);
      } catch (err) {
        record("note", "update", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.noteByID(noteId);
        if (!found) throw new Error(`${noteId} not found for verify`);
        if (found.status !== "archived") throw new Error(`Expected archived, got ${found.status}`);
        record("note", "verify update", true, `Verified ${noteId} status = archived`);
      } catch (err) {
        record("note", "verify update", false, errMsg(err));
      }

      try {
        await deleteNote(noteId, root, { hard: true });
        createdIds.splice(createdIds.findIndex((c) => c.id === noteId), 1);
        record("note", "delete", true, `Deleted ${noteId}`);
      } catch (err) {
        record("note", "delete", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.noteByID(noteId);
        if (found) throw new Error(`${noteId} still exists after delete`);
        record("note", "verify delete", true, `Confirmed ${noteId} absent`);
      } catch (err) {
        record("note", "verify delete", false, errMsg(err));
      }
    }

    // --- Lesson cycle ---
    let lessonId: string | undefined;
    try {
      await withProjectLock(root, { strict: false }, async (result) => {
        const isTeam = result.state.config.team?.enabled === true;
        let displayId: string | undefined;
        if (isTeam) {
          const alloc = allocateTeamLessonId(result.state.lessons);
          lessonId = alloc.id;
          displayId = alloc.displayId;
        } else {
          lessonId = nextLessonID(result.state.lessons);
        }
        const instant = new Date();
        const createdAt = instant.toISOString();
        const today = localDateOf(instant);
        const lesson: Lesson = {
          id: lessonId,
          ...(displayId != null && { displayId }),
          title: "selftest lesson",
          content: "Integration smoke test -- will be deleted.",
          context: "Created by storybloq selftest.",
          source: "manual",
          tags: ["selftest"],
          reinforcements: 0,
          lastValidated: today,
          createdDate: today,
          ...(isTeam && { createdAt }),
          updatedDate: today,
          supersedes: null,
          status: "active",
        };
        await writeLessonUnlocked(lesson, root, { createOnly: true });
      });
      createdIds.push({ type: "lesson", id: lessonId! });
      record("lesson", "create", true, `Created ${lessonId}`);
    } catch (err) {
      record("lesson", "create", false, errMsg(err));
    }

    if (lessonId) {
      try {
        const { state } = await loadProject(root);
        const found = state.lessonByID(lessonId);
        if (!found) throw new Error(`${lessonId} not found after create`);
        record("lesson", "get", true, `Found ${lessonId}`);
      } catch (err) {
        record("lesson", "get", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const existing = state.lessonByID(lessonId);
        if (!existing) throw new Error(`${lessonId} not found for update`);
        const today = todayISO();
        const updated: Lesson = {
          ...existing,
          reinforcements: existing.reinforcements + 1,
          lastValidated: today,
          updatedDate: today,
        };
        await writeLesson(updated, root);
        record("lesson", "update", true, `Updated ${lessonId} reinforcements to 1`);
      } catch (err) {
        record("lesson", "update", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.lessonByID(lessonId);
        if (!found) throw new Error(`${lessonId} not found for verify`);
        if (found.reinforcements !== 1) throw new Error(`Expected 1 reinforcement, got ${found.reinforcements}`);
        record("lesson", "verify update", true, `Verified ${lessonId} reinforcements = 1`);
      } catch (err) {
        record("lesson", "verify update", false, errMsg(err));
      }

      try {
        await deleteLesson(lessonId, root, { hard: true });
        createdIds.splice(createdIds.findIndex((c) => c.id === lessonId), 1);
        record("lesson", "delete", true, `Deleted ${lessonId}`);
      } catch (err) {
        record("lesson", "delete", false, errMsg(err));
      }

      try {
        const { state } = await loadProject(root);
        const found = state.lessonByID(lessonId);
        if (found) throw new Error(`${lessonId} still exists after delete`);
        record("lesson", "verify delete", true, `Confirmed ${lessonId} absent`);
      } catch (err) {
        record("lesson", "verify delete", false, errMsg(err));
      }
    }
  } finally {
    // Best-effort cleanup of any entities still tracked
    for (const { type, id } of createdIds.reverse()) {
      try {
        if (type === "ticket") await deleteTicket(id, root, { force: true, hard: true });
        else if (type === "issue") await deleteIssue(id, root, { hard: true });
        else if (type === "note") await deleteNote(id, root, { hard: true });
        else await deleteLesson(id, root, { hard: true });
      } catch (err) {
        cleanupErrors.push(`Failed to delete ${type} ${id}: ${errMsg(err)}`);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const warnings = await codexInstallationWarnings();
  const result: SelftestResult = {
    passed,
    failed,
    total: results.length,
    results,
    cleanupErrors,
    warnings,
  };

  return { output: formatSelftestResult(result, format) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
