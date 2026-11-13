import { APPEND_ONLY_FIELDS, RESOLUTION_ID_REGEX, resolutionEntryId } from "./append-only-merge.js";
import { canonicalJson } from "./canonical-json.js";
import { ProjectLoaderError } from "./errors.js";
import { MERGE_RESOLUTION_AUTHORITY } from "./receipt-resolve.js";
import { ReceiptSchema } from "./receipts.js";

/**
 * C-v4.1 3.4 (M5): the single enforcement point for the append-only fields
 * (`receipts`, `landings`, `receiptResolutions`). It sits beside the
 * checkpoint guard and runs at ticket and issue write preparation and again
 * in transaction byte authorisation.
 *
 * - Content unchanged (canonical equality, not file bytes) passes, including a
 *   present value that is not an array: it is preserved, never read as empty.
 * - `RECEIPT_APPEND_AUTHORITY` may add exactly one well-formed receipt at the
 *   end of `receipts`; `LANDING_APPEND_AUTHORITY` exactly one object at the end
 *   of `landings`. Every prior element stays equal in canonical content,
 *   malformed, id-less and future-version ones included.
 * - `MERGE_RESOLUTION_AUTHORITY` may drop bodies from `receipts` or `landings`
 *   (order kept, nothing added), append exactly one history entry with its rr-
 *   id, and remove `receipt`/`receipt-opaque` entries from `_conflicts`.
 * - Anything else is refused: a removal, an alteration, a reorder, an append
 *   without authority, a field added where there was none, and any value that
 *   has no canonical form.
 */

export const RECEIPT_APPEND_AUTHORITY: unique symbol = Symbol("receipt-append");
export const LANDING_APPEND_AUTHORITY: unique symbol = Symbol("landing-append");

export type ReceiptsWriteAuthority =
  | typeof RECEIPT_APPEND_AUTHORITY
  | typeof LANDING_APPEND_AUTHORITY
  | typeof MERGE_RESOLUTION_AUTHORITY;

type Raw = Readonly<Record<string, unknown>>;

const RECEIPT_CONFLICT_KINDS = new Set(["receipt", "receipt-opaque"]);

function label(t: Raw): string {
  return typeof t.displayId === "string" ? t.displayId : String(t.id);
}

function refuse(code: string, message: string): never {
  throw new ProjectLoaderError("conflict", `${code}: ${message}`);
}

/** The canonical text of a value, or undefined when it has none. */
function canonical(value: unknown): string | undefined {
  try {
    return canonicalJson(value);
  } catch {
    return undefined;
  }
}

/** True when `sub` is `full` with zero or more elements removed, order kept. */
function isSubsequence(sub: readonly string[], full: readonly string[]): boolean {
  let i = 0;
  for (const text of full) if (i < sub.length && sub[i] === text) i++;
  return i === sub.length;
}

function texts(field: string, who: string, value: unknown[], t: Raw): string[] {
  return value.map((element, index) => {
    const text = canonical(element);
    if (text === undefined) refuse("receipts_unpreservable", `${label(t)}: ${field}[${index}] on the ${who} record has no canonical form, so it cannot be compared or kept.`);
    return text;
  });
}

function checkField(field: string, prior: Raw | null, next: Raw, authority: ReceiptsWriteAuthority | undefined): void {
  const p = prior?.[field];
  const n = next[field];
  if (p === undefined && n === undefined) return;
  const pText = p === undefined ? undefined : canonical(p);
  const nText = n === undefined ? undefined : canonical(n);
  if (p !== undefined && pText === undefined) {
    refuse("receipts_unpreservable", `${label(next)}: the current ${field} has no canonical form, so no write can show it is kept. Repair the file by hand first.`);
  }
  if (n !== undefined && nText === undefined) {
    refuse("receipts_unpreservable", `${label(next)}: the ${field} being written has no canonical form.`);
  }
  if (pText === nText) return;
  if (p !== undefined && !Array.isArray(p)) {
    refuse("receipts_immutable", `${label(next)}: the current ${field} is not an array; it is kept as it is and never replaced. Repair it by hand.`);
  }
  if (n !== undefined && !Array.isArray(n)) {
    refuse("receipts_immutable", `${label(next)}: ${field} must stay an array; a write may not replace it with something else.`);
  }
  if (n === undefined) {
    refuse("receipts_immutable", `${label(next)}: ${field} cannot be removed.`);
  }
  const before = p === undefined ? [] : texts(field, "current", p as unknown[], next);
  const after = texts(field, "new", n as unknown[], next);
  const prefixKept = before.every((text, i) => after[i] === text);

  if (authority === RECEIPT_APPEND_AUTHORITY && field === "receipts") {
    if (after.length === before.length + 1 && prefixKept && ReceiptSchema.safeParse((n as unknown[])[before.length]).success) return;
    refuse("receipts_immutable", `${label(next)}: a receipt append adds exactly one well-formed receipt at the end and keeps every existing element unchanged.`);
  }
  if (authority === LANDING_APPEND_AUTHORITY && field === "landings") {
    const added = (n as unknown[])[before.length];
    if (after.length === before.length + 1 && prefixKept && added !== null && typeof added === "object" && !Array.isArray(added)) return;
    refuse("receipts_immutable", `${label(next)}: a landing append adds exactly one landing at the end and keeps every existing landing unchanged.`);
  }
  if (authority === MERGE_RESOLUTION_AUTHORITY) {
    if (field === "receiptResolutions") {
      const entry = (n as unknown[])[before.length] as Record<string, unknown> | undefined;
      const valid = entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && typeof entry.id === "string" && RESOLUTION_ID_REGEX.test(entry.id) && canonical(entry) !== undefined
        && resolutionEntryId(entry) === entry.id;
      if (after.length === before.length + 1 && prefixKept && valid) return;
      refuse("receipts_immutable", `${label(next)}: a resolution appends exactly one history entry with its rr- id and keeps the history unchanged.`);
    }
    if (p !== undefined && isSubsequence(after, before)) return;
    refuse("receipts_immutable", `${label(next)}: a resolution only removes the bodies its conflict names from ${field}; it never adds, alters or reorders one.`);
  }
  refuse(
    "receipts_immutable",
    `${label(next)}: ${field} is append-only. Receipts change only through \`storybloq receipt add\` and \`storybloq resolve --receipt\`; nothing removes, alters or reorders an element.`,
  );
}

function receiptConflictTexts(t: Raw | null): string[] {
  const conflicts = t?._conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts
    .filter((c) => c !== null && typeof c === "object" && RECEIPT_CONFLICT_KINDS.has(String((c as { kind?: unknown }).kind)))
    .map((c) => canonical(c) ?? `unrepresentable:${String((c as { id?: unknown }).id)}`);
}

export function assertReceiptsWriteAllowed(prior: Raw | null, next: Raw, authority?: ReceiptsWriteAuthority): void {
  for (const field of APPEND_ONLY_FIELDS) checkField(field, prior, next, authority);
  // Receipt conflicts leave _conflicts only through a resolution, and no
  // writer adds one (only the merge driver, which writes no prepared bytes).
  const before = receiptConflictTexts(prior);
  const after = receiptConflictTexts(next);
  const same = before.length === after.length && before.every((t, i) => after[i] === t);
  if (same) return;
  if (authority === MERGE_RESOLUTION_AUTHORITY && after.length === before.length - 1 && isSubsequence(after, before)) return;
  refuse("receipts_immutable", `${label(next)}: receipt conflicts are cleared only by \`storybloq resolve --receipt\` or \`--receipt-conflict\`, one at a time.`);
}

/**
 * 3.3 (B2): the bytes about to be written must carry every append-only field
 * with the same canonical content as the record they were serialised from.
 * A writer that loses content (an own `__proto__` key, ISS-1475) is refused,
 * never silently altered.
 */
export function assertReceiptsPreservable(record: Raw, content: string): void {
  let written: Record<string, unknown>;
  try {
    written = JSON.parse(content) as Record<string, unknown>;
  } catch {
    refuse("receipts_unpreservable", `${label(record)}: the serialised record does not parse.`);
  }
  for (const field of APPEND_ONLY_FIELDS) {
    const a = record[field];
    const b = written[field];
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined || canonical(a) === undefined || canonical(a) !== canonical(b)) {
      refuse("receipts_unpreservable", `${label(record)}: writing would change ${field} (the serialiser cannot keep its content as it is); nothing was written.`);
    }
  }
}

/**
 * 3.4 (restore): the append-only elements on `current` that `next` would
 * drop, named by id (or by position when an element has none). A present
 * value on either side with no canonical form, or a present non-array
 * value, is reported as unpreservable rather than read as empty.
 */
export function appendOnlyDrops(current: Raw | null, next: Raw): { dropped: string[]; unpreservable: string[] } {
  const dropped: string[] = [];
  const unpreservable: string[] = [];
  for (const field of APPEND_ONLY_FIELDS) {
    const c = current?.[field];
    const n = next[field];
    if (c === undefined) continue;
    const cText = canonical(c);
    if (cText === undefined || !Array.isArray(c)) {
      if (cText === undefined || canonical(n) !== cText) unpreservable.push(field);
      continue;
    }
    if (n !== undefined && !Array.isArray(n)) {
      unpreservable.push(field);
      continue;
    }
    const remaining = new Map<string, number>();
    for (const element of (n as unknown[] | undefined) ?? []) {
      const t = canonical(element);
      if (t === undefined) {
        unpreservable.push(field);
        break;
      }
      remaining.set(t, (remaining.get(t) ?? 0) + 1);
    }
    c.forEach((element, index) => {
      const t = canonical(element);
      const left = t === undefined ? 0 : remaining.get(t) ?? 0;
      if (t !== undefined && left > 0) {
        remaining.set(t, left - 1);
        return;
      }
      const id = element !== null && typeof element === "object" && typeof (element as { id?: unknown }).id === "string"
        ? (element as { id: string }).id
        : `${field}[${index}]`;
      dropped.push(`${field}:${id}`);
    });
  }
  return { dropped, unpreservable };
}
