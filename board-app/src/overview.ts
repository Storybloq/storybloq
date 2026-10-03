import { createHash } from "node:crypto";
import type { ProjectState } from "../../src/core/project-state.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { Issue } from "../../src/models/issue.js";
import { hasOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { clip } from "./text.js";
import { BoardError } from "./errors.js";
import {
  columns,
  type Card,
  type Column,
  type Overview,
  type OverviewQuery,
} from "./board-types.js";
export { initialQuery } from "./board-types.js";
export type { Overview } from "./board-types.js";

/** Search corpus stays server-local. overviewPage is the public wire boundary. */
export interface BoardProjection extends Overview {
  search: Map<string, string>;
}
const phaseKey = (id: string) => createHash("sha256").update(id).digest("hex");
const compareID = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const displayLabel = (value: string) => value[0].toUpperCase() + value.slice(1);

interface ProjectedRecord {
  card: Card;
  column: Column;
  index: number;
  order: number;
  date: string;
  searchText: string;
}
function projectRecord(
  state: ProjectState,
  t: Ticket | Issue,
  kind: Card["kind"],
  phaseIndex: Map<string, number>,
  phaseName: Map<string, string>,
): ProjectedRecord {
  const isTicket = kind === "tickets";
  const ticket = isTicket ? (t as Ticket) : undefined,
    issue = isTicket ? undefined : (t as Issue);
  const body = ticket ? ticket.description : issue!.impact;
  const severity = issue?.severity ?? null;
  const blocked = ticket ? state.isBlocked(ticket) : false;
  const type = ticket?.type ?? null;
  const components = issue?.components ?? [];
  const name = t.phase ? phaseName.get(t.phase) : undefined;
  const tags = [
    type ? displayLabel(type) : null,
    name,
    blocked ? "Blocked" : null,
    severity ? displayLabel(severity) : null,
    ...components,
  ].filter((v): v is string => !!v);
  const key = `${isTicket ? "ticket" : "issue"}:${t.id}`;
  const column =
    t.status === "complete" || t.status === "resolved"
      ? "done"
      : t.status === "inprogress"
        ? "inProgress"
        : "open";
  const card: Card = {
    key,
    id: t.id,
    displayId: clip(t.displayId ?? t.id, 80),
    title: clip(t.title, 240),
    kind,
    blocked,
    severity,
    description: clip(body, 320),
    tags: tags.slice(0, 8).map((v) => clip(v, 80)),
    phaseKey: t.phase == null ? null : phaseKey(t.phase),
  };
  const searchText = [t.id, t.displayId ?? "", t.title, body, ...tags]
    .join(" ")
    .toLocaleLowerCase();
  return {
    card,
    column,
    searchText,
    index: t.phase == null ? Infinity : (phaseIndex.get(t.phase) ?? Infinity),
    order: t.order ?? 0,
    date: ticket ? (ticket.completedDate ?? "") : (issue!.resolvedDate ?? ""),
  };
}
function projectColumns(records: ProjectedRecord[]): Overview["columns"] {
  const board = {} as Overview["columns"];
  for (const column of columns) {
    const rows = records
      .filter((r) => r.column === column)
      .sort((a, b) => {
        if (column === "done" && a.date !== b.date)
          return compareID(b.date, a.date);
        return (
          (a.index === b.index ? 0 : a.index < b.index ? -1 : 1) ||
          a.order - b.order ||
          compareID(a.card.id, b.card.id)
        );
      });
    board[column] = {
      items: rows.map((r) => r.card),
      total: rows.length,
      offset: 0,
    };
  }
  return board;
}

export function projectPhases(state: ProjectState) {
  const current = state.roadmap.phases.find(
    (p) => state.phaseStatus(p.id) === "inprogress",
  );
  return state.roadmap.phases.map((p) => ({
    key: phaseKey(p.id),
    name: clip(p.name, 160),
    label: clip(p.label, 40),
    status: state.phaseStatus(p.id),
    current: p.id === current?.id,
  }));
}

/** Mac board presentation with canonical TS lifecycle, checkpoint and blocker rules. */
export function projectOverview(state: ProjectState): BoardProjection {
  const phaseIndex = new Map(state.roadmap.phases.map((p, n) => [p.id, n]));
  const phaseName = new Map(state.roadmap.phases.map((p) => [p.id, p.name]));
  const phases = projectPhases(state);
  const current = state.roadmap.phases[phases.findIndex((p) => p.current)];
  const records = [
    ...state.leafTickets
      .filter((t) => !hasOwnerCheckpoint(t))
      .map((t) => projectRecord(state, t, "tickets", phaseIndex, phaseName)),
    ...state.activeIssues.map((i) =>
      projectRecord(state, i, "issues", phaseIndex, phaseName),
    ),
  ];
  const search = new Map(records.map((r) => [r.card.key, r.searchText]));
  const board = projectColumns(records);
  const severity: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const i of state.activeIssues)
    if (i.status !== "resolved") severity[i.severity]++;
  return {
    project: clip(state.config.project, 120),
    isOrchestrator: state.config.type === "orchestrator",
    loadedAt: new Date().toISOString(),
    phases,
    search,
    hasUnphased: records.some((r) => r.card.phaseKey === null),
    summary: {
      total: state.totalTicketCount,
      complete: state.completeTicketCount,
      blocked: state.leafTickets.filter(
        (t) =>
          !hasOwnerCheckpoint(t) &&
          t.status !== "complete" &&
          state.isBlocked(t),
      ).length,
      openIssues: state.activeIssueCount,
      severity,
    },
    currentPhase: current
      ? {
          id: clip(current.id, 100),
          name: clip(current.name, 160),
          status: state.phaseStatus(current.id),
        }
      : null,
    columns: board,
    limit: 6,
  };
}

export function overviewPage(
  board: BoardProjection,
  q: OverviewQuery,
): Overview {
  const phase = q.phase ?? "all";
  if (
    phase !== "all" &&
    phase !== "unphased" &&
    !board.phases.some((p) => p.key === phase)
  )
    throw new BoardError(
      "This phase is no longer available. Select that phase again to clear the filter.",
    );
  const selected = {} as Overview["columns"];
  const needle = q.query.toLocaleLowerCase();
  for (const column of columns) {
    const filtered = board.columns[column].items.filter(
      (i) =>
        (q.kind === "all" || i.kind === q.kind) &&
        (phase === "all" ||
          (phase === "unphased"
            ? i.phaseKey === null
            : i.phaseKey === phase)) &&
        (board.search.get(i.key) ?? "").includes(needle),
    );
    const offset = Math.min(
      q[column],
      Math.max(0, Math.ceil(filtered.length / q.limit) - 1) * q.limit,
    );
    selected[column] = {
      total: filtered.length,
      offset,
      items: filtered.slice(offset, offset + q.limit),
    };
  }
  const { search: _search, ...publicBoard } = board;
  return { ...publicBoard, columns: selected, limit: q.limit };
}
