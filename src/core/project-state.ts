import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { Roadmap } from "../models/roadmap.js";
import type { Config } from "../models/config.js";
import type { IssueSeverity } from "../models/types.js";
import { resolveRef, buildPrevDisplayIndex, type ResolveResult } from "./resolver.js";
import { compareByRank } from "./fractional-index.js";

export type PhaseStatus = "notstarted" | "inprogress" | "complete";

/**
 * Pure derived-data container. All derivation happens eagerly in the constructor.
 * Direct port of Swift `ProjectState` -- same 7-step pipeline, same query semantics.
 */
export class ProjectState {
  // --- Public raw inputs (readonly) ---
  readonly tickets: readonly Ticket[];
  readonly issues: readonly Issue[];
  readonly notes: readonly Note[];
  readonly lessons: readonly Lesson[];
  readonly roadmap: Readonly<Roadmap>;
  readonly config: Readonly<Config>;
  readonly handoverFilenames: readonly string[];

  // --- Active (lifecycle-filtered) ---
  readonly activeTickets: readonly Ticket[];
  readonly activeIssues: readonly Issue[];
  readonly activeNotes: readonly Note[];
  readonly activeLessons: readonly Lesson[];

  // --- Derived (public readonly) ---
  readonly umbrellaIDs: ReadonlySet<string>;
  readonly leafTickets: readonly Ticket[];
  readonly leafTicketCount: number;
  readonly completeLeafTicketCount: number;

  // --- Derived (private) ---
  private readonly leafTicketsByPhase: Map<string | null, Ticket[]>;
  private readonly childrenByParent: Map<string, Ticket[]>;
  private readonly reverseBlocksMap: Map<string, Ticket[]>;
  private readonly deletionChildrenByParent: Map<string, Ticket[]>;
  private readonly deletionReverseBlocks: Map<string, Ticket[]>;
  private readonly issuesByRelatedTicket: Map<string, Issue[]>;
  private readonly ticketsByID: Map<string, Ticket>;
  private readonly issuesByID: Map<string, Issue>;
  private readonly notesByID: Map<string, Note>;
  private readonly lessonsByID: Map<string, Lesson>;
  private readonly ticketsByDisplayID: Map<string, Ticket[]>;
  private readonly issuesByDisplayID: Map<string, Issue[]>;
  private readonly notesByDisplayID: Map<string, Note[]>;
  private readonly lessonsByDisplayID: Map<string, Lesson[]>;
  private readonly ticketsByPrevDisplayID: Map<string, Ticket[]>;
  private readonly issuesByPrevDisplayID: Map<string, Issue[]>;
  private readonly notesByPrevDisplayID: Map<string, Note[]>;
  private readonly lessonsByPrevDisplayID: Map<string, Lesson[]>;

  // --- Counts ---
  readonly totalTicketCount: number;
  readonly openTicketCount: number;
  readonly completeTicketCount: number;
  readonly activeIssueCount: number;
  readonly issuesBySeverity: ReadonlyMap<IssueSeverity, number>;
  readonly activeNoteCount: number;
  readonly archivedNoteCount: number;
  readonly activeLessonCount: number;
  readonly deprecatedLessonCount: number;
  readonly lessonTags: readonly string[];

  constructor(input: {
    tickets: Ticket[];
    issues: Issue[];
    notes: Note[];
    lessons?: Lesson[];
    roadmap: Roadmap;
    config: Config;
    handoverFilenames: string[];
  }) {
    this.tickets = input.tickets;
    this.issues = input.issues;
    this.notes = input.notes;
    this.lessons = input.lessons ?? [];
    this.roadmap = input.roadmap;
    this.config = input.config;
    this.handoverFilenames = input.handoverFilenames;

    // Step 0: Lifecycle filtering (deleted and archived items excluded from active views)
    this.activeTickets = input.tickets.filter((t) => isActiveLifecycle(t));
    this.activeIssues = input.issues.filter((i) => isActiveLifecycle(i));
    this.activeNotes = input.notes.filter((n) => isActiveLifecycle(n));
    this.activeLessons = this.lessons.filter((l) => isActiveLifecycle(l));

    // Step 0b: Local resolver for ref normalization during graph construction
    const localById = new Map<string, string>();
    const localByDisplay = new Map<string, string[]>();
    const localByPrev = new Map<string, string[]>();
    for (const t of input.tickets) {
      localById.set(t.id, t.id);
      const did = (t as Record<string, unknown>).displayId as string | undefined;
      if (did) localByDisplay.set(did, [...(localByDisplay.get(did) ?? []), t.id]);
      for (const prev of ((t as Record<string, unknown>).previousDisplayIds as string[] | undefined) ?? []) {
        localByPrev.set(prev, [...(localByPrev.get(prev) ?? []), t.id]);
      }
    }
    function localResolve(ref: string): string {
      if (localById.has(ref)) return ref;
      const byDisplay = localByDisplay.get(ref);
      if (byDisplay?.length === 1) return byDisplay[0]!;
      const byPrev = localByPrev.get(ref);
      if (byPrev?.length === 1) return byPrev[0]!;
      return ref;
    }
    function localResolveAll(ref: string): string[] {
      if (localById.has(ref)) return [ref];
      const byDisplay = localByDisplay.get(ref);
      if (byDisplay && byDisplay.length > 0) return byDisplay;
      const byPrev = localByPrev.get(ref);
      if (byPrev && byPrev.length > 0) return byPrev;
      return [ref];
    }

    // Step 1: Umbrella IDs -- only active tickets count as parents
    const parentIDs = new Set<string>();
    for (const t of this.activeTickets) {
      if (t.parentTicket != null) {
        parentIDs.add(localResolve(t.parentTicket));
      }
    }
    this.umbrellaIDs = parentIDs;

    // Step 2: Leaf tickets -- active tickets that are not umbrellas
    this.leafTickets = this.activeTickets.filter((t) => !parentIDs.has(t.id));
    this.leafTicketCount = this.leafTickets.length;
    this.completeLeafTicketCount = this.leafTickets.filter(
      (t) => t.status === "complete",
    ).length;

    // Step 3: Leaf tickets by phase, sorted by order
    const byPhase = new Map<string | null, Ticket[]>();
    for (const t of this.leafTickets) {
      const phase = t.phase;
      const arr = byPhase.get(phase);
      if (arr) {
        arr.push(t);
      } else {
        byPhase.set(phase, [t]);
      }
    }
    for (const [, arr] of byPhase) {
      arr.sort(compareByRank);
    }
    this.leafTicketsByPhase = byPhase;

    // Step 4: Children by parent (display/derived: single-resolution)
    const children = new Map<string, Ticket[]>();
    const delChildren = new Map<string, Ticket[]>();
    for (const t of input.tickets) {
      if (t.parentTicket != null) {
        const resolved = localResolve(t.parentTicket);
        const arr = children.get(resolved);
        if (arr) { arr.push(t); } else { children.set(resolved, [t]); }
        // ISS-705: deletion-safety counts only ACTIVE referrers. A tombstoned
        // ticket's stale parentTicket ref is a warning-level dangling ref, not a
        // blocker (N-059), so it must not refuse a delete. (The display-derived
        // `children` map above keeps all referrers.)
        if (!isDeleted(t)) {
          for (const rid of localResolveAll(t.parentTicket)) {
            const darr = delChildren.get(rid);
            if (darr) { darr.push(t); } else { delChildren.set(rid, [t]); }
          }
        }
      }
    }
    this.childrenByParent = children;
    this.deletionChildrenByParent = delChildren;

    // Step 5: Reverse blocks map (display: single-resolution, deletion: all matches)
    const reverseBlocks = new Map<string, Ticket[]>();
    const delReverseBlocks = new Map<string, Ticket[]>();
    for (const t of input.tickets) {
      for (const blockerID of t.blockedBy) {
        const resolved = localResolve(blockerID);
        const arr = reverseBlocks.get(resolved);
        if (arr) { arr.push(t); } else { reverseBlocks.set(resolved, [t]); }
        // ISS-705: deletion-safety counts only ACTIVE referrers (see Step 4).
        if (!isDeleted(t)) {
          for (const rid of localResolveAll(blockerID)) {
            const darr = delReverseBlocks.get(rid);
            if (darr) { darr.push(t); } else { delReverseBlocks.set(rid, [t]); }
          }
        }
      }
    }
    this.reverseBlocksMap = reverseBlocks;
    this.deletionReverseBlocks = delReverseBlocks;

    // Step 5b: Issues by related ticket (deletion-safety)
    // ISS-705: only ACTIVE issues block a ticket delete; a tombstoned issue's
    // stale relatedTickets ref is a warning-level dangling ref, not a blocker.
    const issuesByRelTicket = new Map<string, Issue[]>();
    for (const i of input.issues) {
      if (isDeleted(i)) continue;
      for (const tref of i.relatedTickets) {
        for (const rid of localResolveAll(tref)) {
          const arr = issuesByRelTicket.get(rid);
          if (arr) { arr.push(i); } else { issuesByRelTicket.set(rid, [i]); }
        }
      }
    }
    this.issuesByRelatedTicket = issuesByRelTicket;

    // Step 6: Lookup indexes
    // Tickets: first-wins (matching Swift uniquingKeysWith: { first, _ in first })
    const tByID = new Map<string, Ticket>();
    for (const t of input.tickets) {
      if (!tByID.has(t.id)) {
        tByID.set(t.id, t);
      }
    }
    this.ticketsByID = tByID;

    // ISS-697: first-wins for issues/notes/lessons, matching Swift's
    // `uniquingKeysWith: { first, _ in first }` (ProjectState.swift). The prior
    // last-wins here, plus a comment that falsely claimed parity, diverged from
    // Swift on a duplicate canonical id. (Canonical ids are unique per
    // one-file-per-id, so first==last in practice; this keeps the contract honest.)
    const iByID = new Map<string, Issue>();
    for (const i of input.issues) {
      if (!iByID.has(i.id)) {
        iByID.set(i.id, i);
      }
    }
    this.issuesByID = iByID;

    // Notes: first-wins (same as issues)
    const nByID = new Map<string, Note>();
    for (const n of input.notes) {
      if (!nByID.has(n.id)) {
        nByID.set(n.id, n);
      }
    }
    this.notesByID = nByID;

    // Lessons: first-wins (same as issues)
    const lByID = new Map<string, Lesson>();
    for (const l of this.lessons) {
      if (!lByID.has(l.id)) {
        lByID.set(l.id, l);
      }
    }
    this.lessonsByID = lByID;

    // Step 6b: Secondary indexes by displayId (for resolver)
    this.ticketsByDisplayID = buildDisplayIndex(input.tickets);
    this.issuesByDisplayID = buildDisplayIndex(input.issues);
    this.notesByDisplayID = buildDisplayIndex(input.notes);
    this.lessonsByDisplayID = buildDisplayIndex(this.lessons);
    this.ticketsByPrevDisplayID = buildPrevDisplayIndex(input.tickets);
    this.issuesByPrevDisplayID = buildPrevDisplayIndex(input.issues);
    this.notesByPrevDisplayID = buildPrevDisplayIndex(input.notes);
    this.lessonsByPrevDisplayID = buildPrevDisplayIndex(this.lessons);

    // Step 7: Counts
    this.totalTicketCount = this.leafTickets.length;
    this.openTicketCount = this.leafTickets.filter(
      (t) => t.status !== "complete",
    ).length;
    this.completeTicketCount = this.leafTickets.filter(
      (t) => t.status === "complete",
    ).length;
    this.activeIssueCount = this.activeIssues.filter(
      (i) => i.status !== "resolved",
    ).length;

    const bySev = new Map<IssueSeverity, number>();
    for (const i of this.activeIssues) {
      if (i.status !== "resolved") {
        bySev.set(i.severity, (bySev.get(i.severity) ?? 0) + 1);
      }
    }
    this.issuesBySeverity = bySev;

    this.activeNoteCount = this.activeNotes.filter(
      (n) => n.status === "active",
    ).length;
    this.archivedNoteCount = this.activeNotes.filter(
      (n) => n.status === "archived",
    ).length;

    this.activeLessonCount = this.activeLessons.filter(
      (l) => l.status === "active",
    ).length;
    this.deprecatedLessonCount = this.activeLessons.filter(
      (l) => l.status === "deprecated" || l.status === "superseded",
    ).length;

    this.lessonTags = [...new Set(this.activeLessons.flatMap((l) => l.tags ?? []))].sort();
  }

  // --- Query Methods ---

  isUmbrella(ticket: Ticket): boolean {
    return this.umbrellaIDs.has(ticket.id);
  }

  phaseTickets(phaseId: string | null): readonly Ticket[] {
    return this.leafTicketsByPhase.get(phaseId) ?? [];
  }

  /** Phase status derived from leaf tickets only. Umbrella stored status is ignored. */
  phaseStatus(phaseId: string | null): PhaseStatus {
    const leaves = this.phaseTickets(phaseId);
    return ProjectState.aggregateStatus(leaves);
  }

  umbrellaChildren(ticketId: string): readonly Ticket[] {
    return this.childrenByParent.get(ticketId) ?? [];
  }

  /** Umbrella status derived from descendant leaf tickets (recursive traversal). */
  umbrellaStatus(ticketId: string): PhaseStatus {
    const visited = new Set<string>();
    const leaves = this.descendantLeaves(ticketId, visited);
    return ProjectState.aggregateStatus(leaves);
  }

  reverseBlocks(ticketId: string): readonly Ticket[] {
    return this.reverseBlocksMap.get(ticketId) ?? [];
  }

  /**
   * A ticket is blocked if any blockedBy reference points to a non-complete, non-deleted ticket.
   * Unknown blocker IDs treated as blocked (conservative). Deleted blockers treated as resolved.
   */
  isBlocked(ticket: Ticket): boolean {
    if (ticket.blockedBy.length === 0) return false;
    for (const ref of ticket.blockedBy) {
      const resolved = this.resolveTicketRef(ref);
      if (resolved.kind === "missing" || resolved.kind === "ambiguous") return true;
      if (resolved.kind === "found" && !isDeleted(resolved.item) && resolved.item.status !== "complete") return true;
    }
    return false;
  }

  get blockedCount(): number {
    return this.leafTickets.filter((t) => t.status !== "complete" && this.isBlocked(t)).length;
  }

  /** True when the project has been initialized but not yet populated with tickets/issues/handovers. */
  get isEmptyScaffold(): boolean {
    return (
      this.tickets.length === 0 &&
      this.issues.length === 0 &&
      this.handoverFilenames.length === 0 &&
      this.isDefaultScaffoldPhases
    );
  }

  private get isDefaultScaffoldPhases(): boolean {
    const { phases } = this.roadmap;
    if (phases.length === 0) return true;
    return phases.length === 1 && phases[0]!.id === "p0";
  }

  ticketByID(id: string): Ticket | undefined {
    return this.ticketsByID.get(id);
  }

  issueByID(id: string): Issue | undefined {
    return this.issuesByID.get(id);
  }

  noteByID(id: string): Note | undefined {
    return this.notesByID.get(id);
  }

  lessonByID(id: string): Lesson | undefined {
    return this.lessonsByID.get(id);
  }

  // --- Resolver ---

  resolveTicketRef(ref: string): ResolveResult<Ticket> {
    return resolveRef(ref, this.ticketsByID, this.ticketsByDisplayID, this.tickets, this.ticketsByPrevDisplayID);
  }

  resolveIssueRef(ref: string): ResolveResult<Issue> {
    return resolveRef(ref, this.issuesByID, this.issuesByDisplayID, this.issues, this.issuesByPrevDisplayID);
  }

  resolveNoteRef(ref: string): ResolveResult<Note> {
    return resolveRef(ref, this.notesByID, this.notesByDisplayID, this.notes, this.notesByPrevDisplayID);
  }

  resolveLessonRef(ref: string): ResolveResult<Lesson> {
    return resolveRef(ref, this.lessonsByID, this.lessonsByDisplayID, this.lessons, this.lessonsByPrevDisplayID);
  }

  resolvedBlockerRefs(ticket: Ticket): ResolveResult<Ticket>[] {
    return ticket.blockedBy.map((ref) => this.resolveTicketRef(ref));
  }

  resolvedBlockers(ticket: Ticket): Ticket[] {
    const result: Ticket[] = [];
    for (const ref of ticket.blockedBy) {
      const resolved = this.resolveTicketRef(ref);
      if (resolved.kind === "found") result.push(resolved.item);
    }
    return result;
  }

  isBlockedByResolver(ticket: Ticket): boolean {
    return this.isBlocked(ticket);
  }

  resolvedParentRef(ticket: Ticket): ResolveResult<Ticket> | null {
    const pt = ticket.parentTicket;
    if (!pt) return null;
    return this.resolveTicketRef(pt);
  }

  resolvedParent(ticket: Ticket): Ticket | null {
    const result = this.resolvedParentRef(ticket);
    return result?.kind === "found" ? result.item : null;
  }

  // --- Deletion Safety ---

  /** IDs of tickets that list `ticketId` in their blockedBy (conservative: includes ambiguous refs). */
  ticketsBlocking(ticketId: string): string[] {
    return (this.deletionReverseBlocks.get(ticketId) ?? []).map((t) => t.id);
  }

  /** IDs of tickets that have `ticketId` as their parentTicket (conservative: includes ambiguous refs). */
  childrenOf(ticketId: string): string[] {
    return (this.deletionChildrenByParent.get(ticketId) ?? []).map((t) => t.id);
  }

  /** IDs of issues that reference `ticketId` in relatedTickets (conservative: includes ambiguous refs). */
  issuesReferencing(ticketId: string): string[] {
    return (this.issuesByRelatedTicket.get(ticketId) ?? []).map((i) => i.id);
  }

  // --- Private ---

  /**
   * Recursively collects all descendant leaf tickets of an umbrella.
   * Uses a visited set to guard against cycles in malformed data.
   */
  private descendantLeaves(
    ticketId: string,
    visited: Set<string>,
  ): Ticket[] {
    if (visited.has(ticketId)) return [];
    visited.add(ticketId);

    const directChildren = this.childrenByParent.get(ticketId) ?? [];
    const leaves: Ticket[] = [];
    for (const child of directChildren) {
      if (this.umbrellaIDs.has(child.id)) {
        leaves.push(...this.descendantLeaves(child.id, visited));
      } else {
        leaves.push(child);
      }
    }
    return leaves;
  }

  /**
   * Shared aggregation logic for phase and umbrella status.
   * - all complete → complete
   * - any inprogress OR any complete (but not all) → inprogress
   * - else → notstarted (nothing started)
   */
  private static aggregateStatus(
    tickets: readonly Ticket[],
  ): PhaseStatus {
    if (tickets.length === 0) return "notstarted";
    const allComplete = tickets.every((t) => t.status === "complete");
    if (allComplete) return "complete";
    const anyProgress = tickets.some((t) => t.status === "inprogress");
    const anyComplete = tickets.some((t) => t.status === "complete");
    if (anyProgress || anyComplete) return "inprogress";
    return "notstarted";
  }
}

export function isActiveLifecycle(item: { lifecycle?: unknown }): boolean {
  return item.lifecycle == null || item.lifecycle === "active";
}

export function isDeleted(item: { lifecycle?: unknown }): boolean {
  return item.lifecycle === "deleted";
}

function buildDisplayIndex<T extends { id: string }>(items: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    // ISS-696: mirror Swift buildDisplayIndex -- trim the displayId and treat an
    // empty/whitespace-only value as absent, falling back to the canonical id.
    // Previously an empty-string displayId was used verbatim as the key, so TS and
    // Swift disagreed on resolution for malformed/hand-edited items.
    const displayId = (item as Record<string, unknown>).displayId;
    const trimmed = typeof displayId === "string" ? displayId.trim() : "";
    const key = trimmed === "" ? item.id : trimmed;
    const arr = index.get(key);
    if (arr) {
      arr.push(item);
    } else {
      index.set(key, [item]);
    }
  }
  return index;
}
