import type { ProjectState } from "../../src/core/project-state.js";
import { readLedger } from "./ledger-reader.js";
import { projectOverview, type BoardProjection } from "./overview.js";
import { clip } from "./text.js";
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
      ...common(t, t.description),
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
        i.impact + (i.resolution ? "\n\nResolution\n" + i.resolution : ""),
      ),
      severity: i.severity,
    })),
  };
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
      .map(({ description, truncated, ...item }) => item),
  };
}
export function detail(board: Board, kind: Kind, id: string) {
  const item = board[kind].find((i) => i.id === id);
  if (!item) fail("This item is no longer available. Refresh the board.");
  return item;
}
