import {
  loadProject,
  writeTicket,
  writeIssue,
  writeNote,
  deleteTicket,
  deleteIssue,
  deleteNote,
} from "../../core/project-loader.js";
import { nextTicketID, nextIssueID, nextNoteID } from "../../core/id-allocation.js";
import { formatSelftestResult } from "../../core/output-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";
import type { Note } from "../../models/note.js";
import type { CommandResult } from "../types.js";
import { todayISO } from "../helpers.js";

export interface SelftestCheckResult {
  readonly entity: "ticket" | "issue" | "note";
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
  const createdIds: { type: "ticket" | "issue" | "note"; id: string }[] = [];
  const cleanupErrors: string[] = [];

  function record(entity: "ticket" | "issue" | "note", step: string, passed: boolean, detail: string): void {
    results.push({ entity, step, passed, detail });
    if (failAfter !== undefined && results.filter((r) => r.passed).length >= failAfter) {
      throw new Error(`failAfter(${failAfter}): induced failure for testing`);
    }
  }

  try {
    // --- Ticket cycle ---
    let ticketId: string | undefined;
    try {
      const { state } = await loadProject(root);
      ticketId = nextTicketID(state.tickets);
      const today = todayISO();
      const ticket: Ticket = {
        id: ticketId,
        title: "selftest ticket",
        type: "chore",
        status: "open",
        phase: null,
        order: 0,
        description: "Integration smoke test — will be deleted.",
        createdDate: today,
        completedDate: null,
        blockedBy: [],
        parentTicket: null,
      };
      await writeTicket(ticket, root);
      createdIds.push({ type: "ticket", id: ticketId });
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
        await deleteTicket(ticketId, root, { force: true });
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
      const { state } = await loadProject(root);
      issueId = nextIssueID(state.issues);
      const today = todayISO();
      const issue: Issue = {
        id: issueId,
        title: "selftest issue",
        status: "open",
        severity: "low",
        components: [],
        impact: "Integration smoke test — will be deleted.",
        resolution: null,
        location: [],
        discoveredDate: today,
        resolvedDate: null,
        relatedTickets: [],
        order: 0,
        phase: null,
      };
      await writeIssue(issue, root);
      createdIds.push({ type: "issue", id: issueId });
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
        await deleteIssue(issueId, root);
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
      const { state } = await loadProject(root);
      noteId = nextNoteID(state.notes);
      const today = todayISO();
      const note: Note = {
        id: noteId,
        title: "selftest note",
        content: "Integration smoke test — will be deleted.",
        tags: [],
        status: "active",
        createdDate: today,
        updatedDate: today,
      };
      await writeNote(note, root);
      createdIds.push({ type: "note", id: noteId });
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
        await deleteNote(noteId, root);
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
  } finally {
    // Best-effort cleanup of any entities still tracked
    for (const { type, id } of createdIds.reverse()) {
      try {
        if (type === "ticket") await deleteTicket(id, root, { force: true });
        else if (type === "issue") await deleteIssue(id, root);
        else await deleteNote(id, root);
      } catch (err) {
        cleanupErrors.push(`Failed to delete ${type} ${id}: ${errMsg(err)}`);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const result: SelftestResult = {
    passed,
    failed,
    total: results.length,
    results,
    cleanupErrors,
  };

  return { output: formatSelftestResult(result, format) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
