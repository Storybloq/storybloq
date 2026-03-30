import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { Roadmap } from "../models/roadmap.js";
import type { Config } from "../models/config.js";
import type { IssueSeverity } from "../models/types.js";

export type PhaseStatus = "notstarted" | "inprogress" | "complete";

/**
 * Pure derived-data container. All derivation happens eagerly in the constructor.
 * Direct port of Swift `ProjectState` — same 7-step pipeline, same query semantics.
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

  // --- Derived (public readonly) ---
  readonly umbrellaIDs: ReadonlySet<string>;
  readonly leafTickets: readonly Ticket[];
  readonly leafTicketCount: number;
  readonly completeLeafTicketCount: number;

  // --- Derived (private) ---
  private readonly leafTicketsByPhase: Map<string | null, Ticket[]>;
  private readonly childrenByParent: Map<string, Ticket[]>;
  private readonly reverseBlocksMap: Map<string, Ticket[]>;
  private readonly ticketsByID: Map<string, Ticket>;
  private readonly issuesByID: Map<string, Issue>;
  private readonly notesByID: Map<string, Note>;
  private readonly lessonsByID: Map<string, Lesson>;

  // --- Counts ---
  readonly totalTicketCount: number;
  readonly openTicketCount: number;
  readonly completeTicketCount: number;
  readonly openIssueCount: number;
  readonly issuesBySeverity: ReadonlyMap<IssueSeverity, number>;
  readonly activeNoteCount: number;
  readonly archivedNoteCount: number;
  readonly activeLessonCount: number;
  readonly deprecatedLessonCount: number;

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

    // Step 1: Umbrella IDs — any ticket ID referenced as parentTicket by another ticket
    const parentIDs = new Set<string>();
    for (const t of input.tickets) {
      if (t.parentTicket != null) {
        parentIDs.add(t.parentTicket);
      }
    }
    this.umbrellaIDs = parentIDs;

    // Step 2: Leaf tickets — not umbrellas
    this.leafTickets = input.tickets.filter((t) => !parentIDs.has(t.id));
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
      arr.sort((a, b) => a.order - b.order);
    }
    this.leafTicketsByPhase = byPhase;

    // Step 4: Children by parent (reverse of parentTicket)
    const children = new Map<string, Ticket[]>();
    for (const t of input.tickets) {
      if (t.parentTicket != null) {
        const arr = children.get(t.parentTicket);
        if (arr) {
          arr.push(t);
        } else {
          children.set(t.parentTicket, [t]);
        }
      }
    }
    this.childrenByParent = children;

    // Step 5: Reverse blocks map (blockerID → tickets blocked by it)
    const reverseBlocks = new Map<string, Ticket[]>();
    for (const t of input.tickets) {
      for (const blockerID of t.blockedBy) {
        const arr = reverseBlocks.get(blockerID);
        if (arr) {
          arr.push(t);
        } else {
          reverseBlocks.set(blockerID, [t]);
        }
      }
    }
    this.reverseBlocksMap = reverseBlocks;

    // Step 6: Lookup indexes
    // Tickets: first-wins (matching Swift uniquingKeysWith: { first, _ in first })
    const tByID = new Map<string, Ticket>();
    for (const t of input.tickets) {
      if (!tByID.has(t.id)) {
        tByID.set(t.id, t);
      }
    }
    this.ticketsByID = tByID;

    // Issues: last-wins (matching Swift uniquingKeysWith: { _, new in new })
    const iByID = new Map<string, Issue>();
    for (const i of input.issues) {
      iByID.set(i.id, i);
    }
    this.issuesByID = iByID;

    // Notes: last-wins (same as issues)
    const nByID = new Map<string, Note>();
    for (const n of input.notes) {
      nByID.set(n.id, n);
    }
    this.notesByID = nByID;

    // Lessons: last-wins (same as issues)
    const lByID = new Map<string, Lesson>();
    for (const l of this.lessons) {
      lByID.set(l.id, l);
    }
    this.lessonsByID = lByID;

    // Step 7: Counts
    this.totalTicketCount = input.tickets.length;
    this.openTicketCount = input.tickets.filter(
      (t) => t.status !== "complete",
    ).length;
    this.completeTicketCount = input.tickets.filter(
      (t) => t.status === "complete",
    ).length;
    this.openIssueCount = input.issues.filter(
      (i) => i.status === "open",
    ).length;

    const bySev = new Map<IssueSeverity, number>();
    for (const i of input.issues) {
      if (i.status === "open") {
        bySev.set(i.severity, (bySev.get(i.severity) ?? 0) + 1);
      }
    }
    this.issuesBySeverity = bySev;

    this.activeNoteCount = input.notes.filter(
      (n) => n.status === "active",
    ).length;
    this.archivedNoteCount = input.notes.filter(
      (n) => n.status === "archived",
    ).length;

    this.activeLessonCount = this.lessons.filter(
      (l) => l.status === "active",
    ).length;
    this.deprecatedLessonCount = this.lessons.filter(
      (l) => l.status === "deprecated" || l.status === "superseded",
    ).length;
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
   * A ticket is blocked if any blockedBy reference points to a non-complete ticket.
   * Unknown blocker IDs treated as blocked (conservative — unknown dependency = assume not cleared).
   */
  isBlocked(ticket: Ticket): boolean {
    if (ticket.blockedBy.length === 0) return false;
    return ticket.blockedBy.some((blockerID) => {
      const blocker = this.ticketsByID.get(blockerID);
      if (!blocker) return true; // unknown = blocked
      return blocker.status !== "complete";
    });
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

  // --- Deletion Safety ---

  /** IDs of tickets that list `ticketId` in their blockedBy. */
  ticketsBlocking(ticketId: string): string[] {
    return (this.reverseBlocksMap.get(ticketId) ?? []).map((t) => t.id);
  }

  /** IDs of tickets that have `ticketId` as their parentTicket. */
  childrenOf(ticketId: string): string[] {
    return (this.childrenByParent.get(ticketId) ?? []).map((t) => t.id);
  }

  /** IDs of issues that reference `ticketId` in relatedTickets. */
  issuesReferencing(ticketId: string): string[] {
    return this.issues
      .filter((i) => i.relatedTickets.includes(ticketId))
      .map((i) => i.id);
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
