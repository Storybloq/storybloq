import type { ProjectState } from "../../src/core/project-state.js";
import { readLedger } from "./ledger-reader.js";
import { projectOverview, type BoardProjection } from "./overview.js";
import { clip } from "./text.js";
import {
  issueEffectiveJson,
  issueStatusLabel,
  ticketEffectiveJson,
  type IssueEffectiveJson,
  type TicketEffectiveJson,
} from "../../src/core/resolution-kind.js";
import { BoardError } from "./errors.js";
export { BoardError } from "./errors.js";
function fail(message: string): never {
  throw new BoardError(message);
}
export type Kind = "tickets" | "issues";
export interface Item {
  id: string;
  displayId: string;
  title: string;
  status: string;
  phase: string | null;
  severity?: string;
  description: string;
  truncated: boolean;
  /** T-486: main's derived withdrawal or resolution kind and disposition evidence, bounded. */
  effective?: BoardTicketEffective | BoardIssueEffective;
}
export interface Board {
  overview: BoardProjection;
  project: string;
  loadedAt: string;
  phases: { id: string; name: string; status: string }[];
  tickets: Item[];
  issues: Item[];
}
export interface Query {
  kind: Kind;
  query: string;
  status: string;
  offset: number;
  limit: number;
}

/** Read-only adapter. The normal loader recovers journals, so it must not run here.
 * A trusted local writer may update files; this detects changes, not a database snapshot.
 * The local OS user remains trusted. This is not a sandbox against hostile filesystem owners.
 */
export async function readBoard(root: string): Promise<Board> {
  return readLedger(root, (state) => projectBoard(state));
}

function projectBoard(state: ProjectState): Board {
  const common = (t: any, text: string): Item => ({
    id: t.id,
    displayId: clip(t.displayId ?? t.id, 80),
    title: clip(t.title, 240),
    status: t.status,
    phase: t.phase ? clip(t.phase, 100) : null,
    description: clip(text, 12000),
    truncated: text.length > 12000,
  });
  return {
    overview: projectOverview(state),
    project: clip(state.config.project, 120),
    loadedAt: new Date().toISOString(),
    phases: state.roadmap.phases.map((p) => ({
      id: clip(p.id, 100),
      name: clip(p.name, 160),
      status: state.phaseStatus(p.id),
    })),
    tickets: state.activeTickets.map((t) => ({
      ...common(t, withdrawalText(ticketEffective(t)) + t.description),
      effective: ticketEffective(t),
      status: state.isUmbrella(t)
        ? {
            notstarted: "open",
            inprogress: "inprogress",
            complete: "complete",
          }[state.umbrellaStatus(t.id)]
        : t.status,
    })),
    issues: state.activeIssues.map((i) => ({
      ...common(
        i,
        issueStateText(i, issueEffective(i)) +
          i.impact +
          (i.resolution ? "\n\nResolution\n" + i.resolution : ""),
      ),
      severity: i.severity,
      effective: issueEffective(i),
    })),
  };
}
// Main sets no length limit on a withdrawal reason or disposition evidence,
// so the board clips them before they reach a response or a description.
export const EFFECTIVE_REASON_LIMIT = 2000;
export const EFFECTIVE_REF_LIMIT = 300;
export interface BoardTicketEffective
  extends Omit<TicketEffectiveJson, "reason"> {
  reason: string | null;
  reasonTruncated: boolean;
}
export interface BoardIssueEffective
  extends Omit<IssueEffectiveJson, "dispositionEvidence"> {
  dispositionEvidence: {
    reason: string;
    ref: string;
    reasonTruncated: boolean;
    refTruncated: boolean;
  } | null;
}
const bounded = (s: string, n: number) => clip(s, n);
function ticketEffective(t: Readonly<Record<string, unknown>>): BoardTicketEffective {
  const view = ticketEffectiveJson(t);
  return {
    ...view,
    reason: view.reason === null ? null : bounded(view.reason, EFFECTIVE_REASON_LIMIT),
    reasonTruncated: (view.reason?.length ?? 0) > EFFECTIVE_REASON_LIMIT,
  };
}
function issueEffective(i: Readonly<Record<string, unknown>>): BoardIssueEffective {
  const view = issueEffectiveJson(i),
    evidence = view.dispositionEvidence;
  return {
    ...view,
    dispositionEvidence: evidence && {
      reason: bounded(evidence.reason, EFFECTIVE_REASON_LIMIT),
      ref: bounded(evidence.ref, EFFECTIVE_REF_LIMIT),
      reasonTruncated: evidence.reason.length > EFFECTIVE_REASON_LIMIT,
      refTruncated: evidence.ref.length > EFFECTIVE_REF_LIMIT,
    },
  };
}
/** List rows carry the kind and state only; evidence text stays in detail. */
function rowEffective(effective: Item["effective"]) {
  if (!effective) return undefined;
  if ("reason" in effective) {
    const { reason, reasonTruncated, ...row } = effective;
    return row;
  }
  const { dispositionEvidence, ...row } = effective;
  return row;
}
function withdrawalText(view: BoardTicketEffective) {
  return view.resolutionKind === "withdrawn"
    ? `Withdrawn: ${view.reason}\n\n`
    : "";
}
function issueStateText(
  i: Readonly<Record<string, unknown>>,
  view: BoardIssueEffective,
) {
  const label = issueStatusLabel(i),
    lines = view.resolutionKind
      ? [label[0].toUpperCase() + label.slice(1)]
      : [];
  if (typeof i.disposition === "string") {
    lines.push(`Disposition: ${i.disposition}`);
    const evidence = view.dispositionEvidence;
    if (evidence) lines.push(`Evidence: ${evidence.reason} (${evidence.ref})`);
  }
  return lines.length ? lines.join("\n") + "\n\n" : "";
}
export function page(board: Board, q: Query) {
  const needle = q.query.toLocaleLowerCase();
  const rows = board[q.kind]
    .filter(
      (i) =>
        (q.status === "all" || i.status === q.status) &&
        `${i.displayId} ${i.title}`.toLocaleLowerCase().includes(needle),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    project: board.project,
    loadedAt: board.loadedAt,
    phases: board.phases,
    kind: q.kind,
    total: rows.length,
    offset: q.offset,
    limit: q.limit,
    items: rows
      .slice(q.offset, q.offset + q.limit)
      .map(({ description, truncated, effective, ...item }) => ({
        ...item,
        ...(effective && { effective: rowEffective(effective) }),
      })),
  };
}
export function detail(board: Board, kind: Kind, id: string) {
  const item = board[kind].find((i) => i.id === id);
  if (!item) fail("This item is no longer available. Refresh the board.");
  return item;
}
