import { duplicateHoldText, duplicateReceiptHolds, readReceipts, type ReceiptEntryRead } from "./receipts.js";

/**
 * C-v4.1 commit 3 (pen ruling Q6): the receipts summary and one page of a
 * record's receipts, for `receiptsPage` on ticket_get and issue_get and for
 * `storybloq receipts <id>`. Pages are numbered from 1 and hold entries in
 * array order. Page 1 always exists (empty when there are no receipts); any
 * other page outside 1..totalPages, or not an integer, is refused.
 */

export const RECEIPTS_PAGE_SIZE = 20;

export interface ReceiptsSummary {
  readonly total: number;
  /** Count per readReceipts entry state. */
  readonly states: Readonly<Record<string, number>>;
  /** Present only when the field itself is not an array. */
  readonly field?: "malformed";
  /** ISS-1435: present only when the record holds a duplicate_id contradiction. */
  readonly duplicates?: readonly string[];
}

export interface ReceiptsPageEntry {
  readonly index: number;
  readonly state: ReceiptEntryRead["state"];
  readonly element: unknown;
}

export interface ReceiptsPageView {
  readonly summary: ReceiptsSummary;
  readonly page: number;
  readonly totalPages: number;
  readonly entries: readonly ReceiptsPageEntry[];
}

export function receiptsSummary(record: Record<string, unknown>): ReceiptsSummary {
  const read = readReceipts(record);
  if (read.state === "missing") return { total: 0, states: {} };
  if (read.state === "malformed") return { total: 0, states: {}, field: "malformed" };
  const states: Record<string, number> = {};
  for (const e of read.entries) states[e.state] = (states[e.state] ?? 0) + 1;
  const duplicates = duplicateReceiptHolds(record);
  return { total: read.entries.length, states, ...(duplicates.length > 0 ? { duplicates } : {}) };
}

export function receiptsPage(
  record: Record<string, unknown>, page: number,
): { ok: true; page: ReceiptsPageView } | { ok: false; message: string } {
  const summary = receiptsSummary(record);
  const totalPages = Math.max(1, Math.ceil(summary.total / RECEIPTS_PAGE_SIZE));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    return { ok: false, message: `invalid_page: receipts page ${String(page)} does not exist; pages run from 1 to ${totalPages} (totalPages ${totalPages}).` };
  }
  const read = readReceipts(record);
  const raw = Array.isArray(record.receipts) ? record.receipts : [];
  const all = read.state === "ok" ? read.entries : [];
  const slice = all.slice((page - 1) * RECEIPTS_PAGE_SIZE, page * RECEIPTS_PAGE_SIZE);
  return {
    ok: true,
    page: { summary, page, totalPages, entries: slice.map((e) => ({ index: e.index, state: e.state, element: raw[e.index] })) },
  };
}

/** One line per entry for text output. */
export function formatReceiptEntry(e: ReceiptsPageEntry): string {
  const el = (e.element && typeof e.element === "object" ? e.element : {}) as Record<string, unknown>;
  const id = typeof el.id === "string" ? el.id : `#${e.index}`;
  const kind = typeof el.kind === "string" ? el.kind : "?";
  const result = typeof el.result === "string" ? el.result : "?";
  return `${id} ${kind} ${result}${e.state === "ok" ? "" : ` (${e.state})`}`;
}

/**
 * The `receipts` part of a ticket_get or issue_get reply (Q6): JSON always
 * carries the summary, plus one page when `page` is given; text adds lines
 * only when the record has receipts (or a malformed field).
 */
export function receiptsGetView(
  record: Record<string, unknown>, page: number | undefined,
): { ok: true; json: Record<string, unknown>; lines: string[] } | { ok: false; message: string } {
  const summary = receiptsSummary(record);
  const lines: string[] = [];
  const counts = Object.entries(summary.states).map(([k, n]) => `${k} ${n}`).join(", ");
  if (summary.field === "malformed") lines.push("Receipts: the receipts field is not an array");
  else if (summary.total > 0) lines.push(`Receipts: ${summary.total} (${counts})`);
  for (const id of summary.duplicates ?? []) lines.push(`Receipts held: ${duplicateHoldText(id)}`);
  if (page === undefined) return { ok: true, json: { summary }, lines };
  const view = receiptsPage(record, page);
  if (!view.ok) return view;
  const p = view.page;
  if (p.entries.length > 0) {
    lines.push(`Receipts page ${p.page} of ${p.totalPages}:`);
    for (const e of p.entries) lines.push(`- ${formatReceiptEntry(e)}`);
  }
  return { ok: true, json: { summary, page: p.entries, pageNumber: p.page, totalPages: p.totalPages }, lines };
}
