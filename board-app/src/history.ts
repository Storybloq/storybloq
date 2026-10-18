import { createHash } from "node:crypto";
import {
  extractHandoverDate,
  extractHandoverTitle,
} from "../../src/core/handover-parser.js";
import { readLedger } from "./ledger-reader.js";
import { projectPhases } from "./overview.js";
import { BoardError } from "./errors.js";
import { clip } from "./text.js";
import type { BoardPhase } from "./board-types.js";
export const selector = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function calendarDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
    ? value
    : null;
}
export interface HandoverRow {
  key: string;
  title: string;
  date: string | null;
}
export interface HistoryGroup {
  key: string;
  date: string | null;
  title: string;
  count: number;
  previewTitles?: string[];
  singleHandover?: HandoverRow;
}
export interface Milestone {
  key: string;
  phaseKey: string;
  title: string;
  label: string;
  summary: string;
  date: string | null;
}
export interface History {
  phases: BoardPhase[];
  hasUnphased: boolean;
  groups: {
    items: HistoryGroup[];
    total: number;
    offset: number;
    limit: number;
  };
  milestones: Milestone[];
  loadedAt: string;
}
export interface HistoryQuery {
  phase: string;
  offset: number;
  limit: number;
}
interface PrivateRow extends HandoverRow {
  filename: string;
}
/** Internal index only. Never serialize the index or ranges into MCP output. */
export interface HistoryIndex {
  phases: BoardPhase[];
  hasUnphased: boolean;
  rows: PrivateRow[];
  milestones: Milestone[];
  ranges: Map<string, string[]>;
  loadedAt: string;
}
function paginate<T>(items: T[], offset: number, limit: number) {
  offset = Math.min(
    offset,
    Math.max(0, Math.ceil(items.length / limit) - 1) * limit,
  );
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}
function row(filename: string): PrivateRow {
  return {
    filename,
    key: selector(filename),
    date: calendarDate(extractHandoverDate(filename)),
    title: clip(extractHandoverTitle(filename), 240) || "Handover",
  };
}
export async function readHistoryIndex(root: string): Promise<HistoryIndex> {
  return readLedger(root, async (state, scope) => {
    const phases = projectPhases(state);
    const ranges = new Map<string, string[]>([
      ...phases.map((p) => [p.key, []] as [string, string[]]),
      ["unphased", []],
    ]);
    const completed = new Map<string, string[]>(),
      created = new Map<string, string[]>();
    for (const t of state.activeTickets) {
      const key = t.phase == null ? "unphased" : selector(t.phase),
        start = calendarDate(t.createdDate),
        end = calendarDate(t.completedDate ?? null);
      if (start) {
        ranges.get(key)?.push(start);
        const values = created.get(key);
        if (values) values.push(start);
        else created.set(key, [start]);
      }
      if (end) {
        ranges.get(key)?.push(end);
        const values = completed.get(key);
        if (values) values.push(end);
        else completed.set(key, [end]);
      }
    }
    for (const dates of ranges.values()) dates.sort();
    const milestones = state.roadmap.phases
      .filter((p) => state.phaseStatus(p.id) === "complete")
      .map((p) => {
        const key = selector(p.id);
        const latest = (values: string[] | undefined) =>
          values?.reduce((a, b) => (a > b ? a : b), "") || null;
        return {
          key: selector("milestone:" + p.id),
          phaseKey: key,
          title: clip(p.name, 160),
          label: clip(p.label, 40),
          summary: clip(p.summary ?? "", 320),
          date: latest(completed.get(key)) ?? latest(created.get(key)),
        };
      });
    const rows = (await scope.files("handovers", ".md"))
      .map(row)
      .sort((a, b) => {
        if (a.date !== b.date)
          return a.date === null
            ? 1
            : b.date === null
              ? -1
              : b.date.localeCompare(a.date);
        const seq = (s: string) => /^\d{4}-\d{2}-\d{2}-\d{2}-/.test(s);
        return (
          Number(seq(b.filename)) - Number(seq(a.filename)) ||
          b.filename.localeCompare(a.filename)
        );
      });
    return {
      phases,
      hasUnphased: state.activeTickets.some((t) => t.phase == null),
      rows,
      milestones,
      ranges,
      loadedAt: new Date().toISOString(),
    };
  });
}
/** Concurrent metadata requests share one validated index; completed reads are discarded. */
export function transientHistory(
  root: string,
  read: typeof readHistoryIndex = readHistoryIndex,
) {
  let pending: ReturnType<typeof readHistoryIndex> | undefined;
  return () => {
    if (!pending)
      pending = read(root).finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
export function historyPage(index: HistoryIndex, q: HistoryQuery): History;
export function historyPage(
  index: HistoryIndex,
  q: HistoryQuery,
  group: string,
): { items: HandoverRow[]; total: number; offset: number; limit: number };
export function historyPage(
  index: HistoryIndex,
  q: HistoryQuery,
  group?: string,
) {
  if (q.phase !== "all" && !index.ranges.has(q.phase))
    throw new BoardError(
      "This phase is no longer available. Select All Phases, then refresh.",
    );
  const dates = index.ranges.get(q.phase) ?? [];
  const rows = index.rows.filter(
    (h) =>
      q.phase === "all" ||
      (dates.length > 0 &&
        h.date !== null &&
        h.date >= dates[0] &&
        h.date <= dates.at(-1)!),
  );
  if (group)
    return paginate(
      rows
        .filter((h) => selector(h.date ?? "unknown") === group)
        .map(({ filename, ...publicRow }) => publicRow),
      q.offset,
      q.limit,
    );
  const byDate = new Map<string | null, HistoryGroup>();
  for (const h of rows) {
    let group = byDate.get(h.date);
    if (!group) {
      group = {
        key: selector(h.date ?? "unknown"),
        date: h.date,
        title: h.date ?? "Unknown date",
        count: 0,
        previewTitles: [],
        singleHandover: { key: h.key, title: h.title, date: h.date },
      };
      byDate.set(h.date, group);
    }
    group.count++;
    if (group.previewTitles!.length < 3) group.previewTitles!.push(h.title);
    if (group.count > 1) delete group.singleHandover;
  }
  const groups = [...byDate.values()];
  return {
    phases: index.phases,
    hasUnphased: index.hasUnphased,
    groups: paginate(groups, q.offset, q.limit),
    milestones: index.milestones.filter(
      (m) => q.phase === "all" || m.phaseKey === q.phase,
    ),
    loadedAt: index.loadedAt,
  };
}
export async function readHandover(root: string, id: string) {
  return readLedger(root, async (_, scope) => {
    const filename = (await scope.files("handovers", ".md")).find(
      (f) => selector(f) === id,
    );
    if (!filename)
      throw new BoardError(
        "This handover is no longer available. Refresh the timeline.",
      );
    const h = row(filename),
      content = await scope.text("handovers", filename);
    return {
      key: h.key,
      title: h.title,
      date: h.date,
      content: clip(content, 48000),
      truncated: content.length > 48000,
    };
  });
}
