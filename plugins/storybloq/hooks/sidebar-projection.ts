/**
 * T-508: the ledger sidebar Mod's projection of `.story/`.
 *
 * WHY THIS FILE IS HERE AND NOT IN src/core. A Claude Code hooks module
 * "imports its own files by relative path and 'claude-code', nothing else":
 * `claude plugin validate` refuses an import from outside the plugin's folder
 * and refuses any `node:` import, and `src/core`'s status projection reaches
 * both. So the numbers are computed here, in a file the client will load, and
 * `test/plugin/sidebar-projection.test.ts` asserts they equal the ones
 * `storybloq status --compact` prints for the same fixture `.story/`. That
 * test is the whole of "do not fork the projection": there is one set of
 * rules, and two implementations that are held equal.
 *
 * Every rule below is the CLI's, reproduced deliberately:
 *   - active means `lifecycle` absent or "active"; deleted is out of every count
 *   - a ticket named as another's `parentTicket` is an umbrella and never a leaf
 *   - counts are over leaves only, so an umbrella's own status is ignored
 *   - a phase's status aggregates its leaves: all complete is complete, any
 *     complete or in progress is in progress, otherwise not started
 *   - a blocker reference resolves by id, then displayId, then a previous
 *     displayId; one that is missing or ambiguous counts as blocking, which is
 *     the conservative reading the CLI takes
 *
 * Pure: no clock, no I/O, and one import, the plugin's own display-safety
 * function. The caller reads the files (`$.fs`) and caches what
 * `extractRecord` returns; this module only counts.
 */

import { displaySafe } from "./stage-label.js";

/** How long a title may be once cached. The store holds 4 MiB for the whole plugin. */
const TITLE_CAP = 80;

/** How many handover names the sidebar names below the board. */
const HANDOVERS_SHOWN = 2;

/** The severities the ledger uses, in the order the sidebar shows them. */
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type LedgerKind = "ticket" | "issue";

export type PhaseStatus = "complete" | "inprogress" | "notstarted";

/** A ticket, reduced to the fields the sidebar counts or shows. */
export interface SidebarTicket {
  readonly kind: "ticket";
  readonly id: string;
  /** Raw, as the record carries it: absent is null, not the id. The two
   *  resolvers below differ on exactly that. */
  readonly displayId: string | null;
  readonly previousDisplayIds: readonly string[];
  readonly title: string;
  readonly status: string;
  readonly phase: string | null;
  readonly parentTicket: string | null;
  readonly blockedBy: readonly string[];
  readonly lifecycle: string | null;
  readonly order: number;
}

/** An issue, reduced the same way. */
export interface SidebarIssue {
  readonly kind: "issue";
  readonly id: string;
  readonly displayId: string | null;
  readonly previousDisplayIds: readonly string[];
  readonly title: string;
  readonly status: string;
  readonly severity: string;
  readonly lifecycle: string | null;
}

export type SidebarRecord = SidebarTicket | SidebarIssue;

export interface SidebarPhase {
  readonly label?: string;
  readonly id: string;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly leafCount: number;
}

/** One ledger item as a board row: what the column shows and how it is marked. */
export interface SidebarBoardCard {
  /** Stable identity, independent of reconciled display IDs. */
  readonly key: string;
  readonly id: string;
  readonly title: string;
  /** An unfinished ticket whose blockedBy still points at something unfinished. */
  readonly blocked: boolean;
  /** Which side of the ledger the row came from. */
  readonly kind: LedgerKind;
  /** An issue's severity; null on a ticket, which has none. */
  readonly severity: string | null;
}

/** Every active leaf and issue appears once, in its recorded status column.
 * Blocking is a card attribute, so a blocked in-progress story stays there.
 * Unknown unfinished statuses belong to Open; completed records belong to Done.
 */
export interface SidebarBoard {
  readonly open: readonly SidebarBoardCard[];
  readonly inProgress: readonly SidebarBoardCard[];
  readonly done: readonly SidebarBoardCard[];
}

export interface SidebarTicketRef {
  readonly id: string;
  readonly title: string;
  readonly phase: string | null;
}

export interface SidebarInput {
  readonly project: string;
  readonly phases: readonly { readonly id: string; readonly name: string; readonly label?: string }[];
  readonly tickets: readonly SidebarTicket[];
  readonly issues: readonly SidebarIssue[];
  readonly handoverFilenames: readonly string[];
}

export interface SidebarProjection {
  readonly project: string;
  readonly totalTickets: number;
  readonly completeTickets: number;
  readonly openTickets: number;
  readonly blockedTickets: number;
  readonly openIssues: number;
  readonly issuesBySeverity: Readonly<Record<string, number>>;
  readonly phases: readonly SidebarPhase[];
  readonly currentPhase: SidebarPhase | null;
  readonly inProgressTickets: readonly SidebarTicketRef[];
  readonly board: SidebarBoard;
  /** The newest handovers, newest first, at most HANDOVERS_SHOWN of them. */
  readonly latestHandovers: readonly string[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Where a severity sits in the order the board reads them, worst first.
 *
 * One the ledger does not use sorts after all of them rather than throwing
 * the column's order away: this reads a hand-editable file.
 */
function severityRank(severity: string): number {
  const at = (SEVERITIES as readonly string[]).indexOf(severity);
  return at === -1 ? SEVERITIES.length : at;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

/**
 * Reads one ledger file's text into the fields the sidebar keeps, or null when
 * the text is not a record of that kind.
 *
 * Null rather than a throw: the Mod reads whatever is in the directory, and a
 * half-written file during someone else's transaction must cost one row, not
 * the pane. The CLI's loader takes the same line (it skips a corrupt entry with
 * a warning), so skipping here keeps the two projections equal.
 *
 * The title is truncated at extraction, not at render: this is what goes into
 * `$.store`, and a ledger of two thousand untruncated records would spend the
 * store's whole 4 MiB on prose the pane never shows.
 */
export function extractRecord(kind: LedgerKind, text: string): SidebarRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const id = asString(raw["id"]);
  const status = asString(raw["status"]);
  if (id === null || status === null) return null;

  const displayId = asString(raw["displayId"]);
  // ISS-1306: a title is ledger text any teammate or tool wrote. Made safe to
  // draw before the cap, so the cap counts what the pane shows.
  const title = displaySafe(asString(raw["title"]) ?? "").slice(0, TITLE_CAP);
  const lifecycle = asString(raw["lifecycle"]);
  const previousDisplayIds = asStringArray(raw["previousDisplayIds"]);

  if (kind === "issue") {
    const severity = asString(raw["severity"]);
    if (severity === null) return null;
    return { kind: "issue", id, displayId, previousDisplayIds, title, status, severity, lifecycle };
  }

  const orderRaw = raw["order"];
  return {
    kind: "ticket",
    id,
    displayId,
    previousDisplayIds,
    title,
    status,
    phase: asString(raw["phase"]),
    parentTicket: asString(raw["parentTicket"]),
    blockedBy: asStringArray(raw["blockedBy"]),
    lifecycle,
    order: typeof orderRaw === "number" && Number.isFinite(orderRaw) ? orderRaw : 0,
  };
}

function isActive(record: { readonly lifecycle: string | null }): boolean {
  return record.lifecycle === null || record.lifecycle === "active";
}

/** The CLI's three-step reference resolution, over every ticket including deleted ones. */
type Resolution =
  | { readonly kind: "found"; readonly item: SidebarTicket }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "missing" };

function buildResolver(tickets: readonly SidebarTicket[]): (ref: string) => Resolution {
  const byId = new Map<string, SidebarTicket>();
  const byDisplay = new Map<string, SidebarTicket[]>();
  const byPrev = new Map<string, SidebarTicket[]>();
  for (const t of tickets) {
    // First wins, as the CLI's index does.
    if (!byId.has(t.id)) byId.set(t.id, t);
    // buildDisplayIndex: the displayId trimmed, and the id where it is blank
    // or absent.
    const trimmedDisplay = (t.displayId ?? "").trim();
    const displayKey = trimmedDisplay === "" ? t.id : trimmedDisplay;
    const atDisplay = byDisplay.get(displayKey);
    if (atDisplay) atDisplay.push(t);
    else byDisplay.set(displayKey, [t]);
    for (const prev of t.previousDisplayIds) {
      const trimmed = prev.trim();
      if (trimmed === "") continue;
      const atPrev = byPrev.get(trimmed);
      if (atPrev) atPrev.push(t);
      else byPrev.set(trimmed, [t]);
    }
  }
  return (ref: string): Resolution => {
    const hit = byId.get(ref);
    if (hit) return { kind: "found", item: hit };
    const display = byDisplay.get(ref);
    if (display && display.length === 1) return { kind: "found", item: display[0]! };
    if (display && display.length > 1) return { kind: "ambiguous" };
    const prev = byPrev.get(ref);
    if (prev && prev.length === 1) return { kind: "found", item: prev[0]! };
    if (prev && prev.length > 1) return { kind: "ambiguous" };
    return { kind: "missing" };
  };
}

/**
 * Parent references, resolved as `ProjectState` resolves them when it builds
 * its graph, through `ticketRefNormalizer` in src/core/ticket-counts.ts:
 *
 *   if (byId.has(ref)) return ref;
 *   const display = byDisplay.get(ref);
 *   if (display !== undefined) return display.length === 1 ? display[0] : ref;
 *   const prev = byPrev.get(ref);
 *   if (prev?.length === 1) return prev[0];
 *   return ref;
 *
 * This is NOT the blocker resolver above: a missing or ambiguous parent ref
 * comes back unchanged rather than as a verdict.
 *
 * T-486 U2-3a changed the precedence: a ref that any ticket holds as its
 * CURRENT displayId resolves only when exactly one does, and an ambiguous one
 * ends the search there. A previous displayId is consulted only
 * when no ticket currently holds the ref. So a ref that two tickets currently
 * answer to and one ticket used to answer to stays unresolved, and the one
 * that used to answer to it is not made an umbrella by it.
 *
 * This file cannot import that function (see the top of the file), so this
 * is a copy, and `test/plugin/sidebar-projection.test.ts` holds the two equal
 * ref by ref over one fixture (mutant M-PARENT-AMBIGUOUS restores the old
 * fall-through here and that test goes red).
 *
 * One thing still differs from the blocker resolver above: the index is built
 * on the RAW displayId only where a record carries one, with no trimming and
 * no falling back to the id, so a ticket with no displayId is not indexed
 * under its own id here even though `buildDisplayIndex` does index it that
 * way.
 *
 * A ref that resolves to nothing comes back unchanged, which is what makes an
 * unresolvable parent name an umbrella id nothing matches: no ticket is
 * excluded from the leaves by it, and none should be.
 */
export function buildParentResolver(tickets: readonly SidebarTicket[]): (ref: string) => string {
  const byId = new Set<string>();
  const byDisplay = new Map<string, string[]>();
  const byPrev = new Map<string, string[]>();
  for (const t of tickets) {
    byId.add(t.id);
    if (t.displayId !== null && t.displayId !== "") {
      const at = byDisplay.get(t.displayId);
      if (at) at.push(t.id);
      else byDisplay.set(t.displayId, [t.id]);
    }
    for (const prev of t.previousDisplayIds) {
      const at = byPrev.get(prev);
      if (at) at.push(t.id);
      else byPrev.set(prev, [t.id]);
    }
  }
  return (ref: string): string => {
    if (byId.has(ref)) return ref;
    const display = byDisplay.get(ref);
    if (display !== undefined) return display.length === 1 ? display[0]! : ref;
    const prev = byPrev.get(ref);
    if (prev && prev.length === 1) return prev[0]!;
    return ref;
  };
}

/**
 * T-486 U2-3b: the canonical ids claimed by more than one record. The CLI's
 * applyTicketIdentityPolicy (src/core/ticket-counts.ts) leaves every such
 * record out of every count and out of dependency release, so the sidebar
 * does the same: none of them is a leaf, an umbrella or a parent, and a
 * blocker that names one never releases.
 */
function duplicatedTicketIds(tickets: readonly SidebarTicket[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.id)) duplicated.add(t.id);
    else seen.add(t.id);
  }
  return duplicated;
}

/** The counted population: every record whose canonical id no other record claims. */
export function countedSidebarTickets(tickets: readonly SidebarTicket[]): SidebarTicket[] {
  const duplicated = duplicatedTicketIds(tickets);
  return tickets.filter((t) => !duplicated.has(t.id));
}

function aggregateStatus(leaves: readonly SidebarTicket[]): PhaseStatus {
  if (leaves.length === 0) return "notstarted";
  if (leaves.every((t) => t.status === "complete")) return "complete";
  const anyProgress = leaves.some((t) => t.status === "inprogress");
  const anyComplete = leaves.some((t) => t.status === "complete");
  return anyProgress || anyComplete ? "inprogress" : "notstarted";
}

/**
 * The numbers the pane draws, from records the caller already read.
 *
 * Held equal to `buildCompactStatusData` by the repo's own test; change a rule
 * here without changing it there and that test goes red.
 */
export function projectSidebar(input: SidebarInput): SidebarProjection {
  const resolve = buildResolver(input.tickets);
  // Blockers resolve over every record, as the CLI's isBlocked does; parents
  // and leaves come from the counted population, as its umbrellaIdsOf does.
  const duplicated = duplicatedTicketIds(input.tickets);
  const counted = input.tickets.filter((t) => !duplicated.has(t.id));
  const resolveParent = buildParentResolver(counted);

  const activeTickets = counted.filter(isActive);
  const activeIssues = input.issues.filter(isActive);

  // An umbrella is any ticket another active ticket names as its parent. The
  // reference is normalized first, so a parent named by displayId still makes
  // that ticket an umbrella.
  const umbrellaIds = new Set<string>();
  for (const t of activeTickets) {
    if (t.parentTicket === null) continue;
    umbrellaIds.add(resolveParent(t.parentTicket));
  }

  const leaves = activeTickets.filter((t) => !umbrellaIds.has(t.id));
  const completeTickets = leaves.filter((t) => t.status === "complete").length;

  const isBlocked = (t: SidebarTicket): boolean => {
    for (const ref of t.blockedBy) {
      const resolved = resolve(ref);
      if (resolved.kind === "missing" || resolved.kind === "ambiguous") return true;
      if (duplicated.has(resolved.item.id)) return true;
      if (resolved.item.lifecycle !== "deleted" && resolved.item.status !== "complete") return true;
    }
    return false;
  };

  const phases: SidebarPhase[] = input.phases.map((p) => {
    const ofPhase = leaves.filter((t) => t.phase === p.id);
    return { id: p.id, name: p.name, label: p.label, status: aggregateStatus(ofPhase), leafCount: ofPhase.length };
  });

  const issuesBySeverity: Record<string, number> = {};
  for (const severity of SEVERITIES) issuesBySeverity[severity] = 0;
  let openIssues = 0;
  for (const i of activeIssues) {
    if (i.status === "resolved") continue;
    openIssues += 1;
    issuesBySeverity[i.severity] = (issuesBySeverity[i.severity] ?? 0) + 1;
  }

  const inProgressTickets = leaves
    .filter((t) => t.status === "inprogress")
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ id: t.displayId ?? t.id, title: t.title, phase: t.phase }));

  const currentPhase =
    phases.find((p) => p.status === "inprogress")
    ?? phases.find((p) => p.status === "notstarted")
    ?? null;

  // The whole project, every phase: the owner wants the board to be the
  // ledger's shape, so its counts are the ones `storybloq status` prints. The
  // column cap is what keeps a thousand complete tickets off the screen, not
  // a filter that changes what the numbers mean.
  const boardLeaves = leaves;
  const card = (t: SidebarTicket): SidebarBoardCard => ({
    key: `ticket:${t.id}`,
    id: t.displayId ?? t.id,
    title: t.title,
    blocked: t.status !== "complete" && isBlocked(t),
    kind: "ticket",
    severity: null,
  });
  const issueCard = (i: SidebarIssue): SidebarBoardCard => ({
    key: `issue:${i.id}`,
    id: i.displayId ?? i.id,
    title: i.title,
    // An issue is never blocked: it carries no blockedBy for anything to
    // point at.
    blocked: false,
    kind: "issue",
    severity: i.severity,
  });
  // Ticket order, then the id as the tie-break, so the columns are stable
  // between renders and between sessions. Order alone is not enough: the
  // ledger hands out the same order number freely (every ticket filed without
  // one shares a default), and Array.prototype.sort is only stable with
  // respect to INPUT order, which here is directory read order. Done sorts
  // the other way, newest first, and breaks its ties the other way too.
  const byOrderAscending = (a: SidebarTicket, b: SidebarTicket): number =>
    (a.order - b.order)
    || (a.displayId ?? a.id).localeCompare(b.displayId ?? b.id)
    // The canonical id has the last word: two tickets can share an order AND
    // a display id (`storybloq reconcile` exists for exactly that), and
    // without this they still compare equal and swap on read order.
    || a.id.localeCompare(b.id);
  // Issues sort by how much they matter and then by id, in every column: an
  // issue has no order field to sort on, and severity is the only ranking the
  // ledger gives. The id is the tie-break for the same reason it is on a
  // ticket, and the canonical id has the last word for the same reason again.
  const bySeverityThenId = (a: SidebarIssue, b: SidebarIssue): number =>
    (severityRank(a.severity) - severityRank(b.severity))
    || (a.displayId ?? a.id).localeCompare(b.displayId ?? b.id)
    || a.id.localeCompare(b.id);
  // Tickets first, then issues: the two are different things and a column
  // that interleaves them reads as one list of neither.
  const withIssues = (
    tickets: readonly SidebarBoardCard[],
    belongs: (i: SidebarIssue) => boolean,
  ): readonly SidebarBoardCard[] => [
    ...tickets,
    ...activeIssues.filter(belongs).slice().sort(bySeverityThenId).map(issueCard),
  ];
  const board: SidebarBoard = {
    // Open is the REMAINDER, not a status match, on both sides of the ledger.
    // It is hand-editable JSON and this reads it raw, so a leaf can carry a
    // status the CLI's enum does not have ("blocked" and "deferred" both
    // occur) and so can an issue ("closed", "wontfix"); matching on "open"
    // drops those records out of every column while they still count in
    // leafCount and openIssues, and the board then does not add up.
    open: withIssues(
      boardLeaves
        .filter((t) => t.status !== "complete" && t.status !== "inprogress")
        .sort(byOrderAscending)
        .map(card),
      (i) => i.status !== "inprogress" && i.status !== "resolved",
    ),
    inProgress: withIssues(
      boardLeaves.filter((t) => t.status === "inprogress").sort(byOrderAscending).map(card),
      (i) => i.status === "inprogress",
    ),
    // Newest first: the last thing finished is the useful one to see, and the
    // rest is history the ledger already keeps.
    done: withIssues(
      boardLeaves
        .filter((t) => t.status === "complete")
        .sort(
          (a, b) =>
            (b.order - a.order)
            || (b.displayId ?? b.id).localeCompare(a.displayId ?? a.id)
            || b.id.localeCompare(a.id),
        )
        .map(card),
      (i) => i.status === "resolved",
    ),
  };

  // Names are date-led, so a reverse sort is newest first. It is exact
  // between two names of the same shape and deterministic always, but it
  // cannot order a date-only name against a timestamped one from the same day
  // (2026-01-02-x sorts before 2026-01-02-193000-y whatever their real order).
  // Reading each file's mtime to do better would cost a $.fs.stat per
  // handover on every refresh, which is not worth the tie.
  const latestHandovers = [...input.handoverFilenames].sort().reverse().slice(0, HANDOVERS_SHOWN);

  return {
    project: input.project,
    totalTickets: leaves.length,
    completeTickets,
    openTickets: leaves.length - completeTickets,
    blockedTickets: leaves.filter((t) => t.status !== "complete" && isBlocked(t)).length,
    openIssues,
    issuesBySeverity,
    phases,
    currentPhase,
    inProgressTickets,
    board,
    latestHandovers,
  };
}
