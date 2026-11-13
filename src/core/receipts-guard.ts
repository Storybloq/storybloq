import { createHash } from "node:crypto";
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
 * - `MERGE_RESOLUTION_AUTHORITY` admits one resolution transition (3.6), checked
 *   as a whole: exactly one `receipt`/`receipt-opaque` conflict leaves
 *   `_conflicts`, exactly one history entry naming that conflict is appended
 *   with its rr- id, the only elements removed are bodies of the conflict's
 *   field whose digests the conflict names and that the entry keeps, a kept
 *   side's body stays, and every other element of every field is unchanged.
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
  refuse(
    "receipts_immutable",
    `${label(next)}: ${field} is append-only. Receipts change only through \`storybloq receipt add\` and \`storybloq resolve --receipt\`; nothing removes, alters or reorders an element.`,
  );
}

function receiptConflicts(t: Raw | null): { text: string; raw: Record<string, unknown> }[] {
  const conflicts = t?._conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts
    .filter((c) => c !== null && typeof c === "object" && RECEIPT_CONFLICT_KINDS.has(String((c as { kind?: unknown }).kind)))
    .map((c) => ({ text: canonical(c) ?? `unrepresentable:${String((c as { id?: unknown }).id)}`, raw: c as Record<string, unknown> }));
}

export function assertReceiptsWriteAllowed(prior: Raw | null, next: Raw, authority?: ReceiptsWriteAuthority): void {
  if (authority === MERGE_RESOLUTION_AUTHORITY) {
    assertResolutionTransition(prior, next);
    return;
  }
  for (const field of APPEND_ONLY_FIELDS) checkField(field, prior, next, authority);
  // Receipt conflicts leave _conflicts only through a resolution, and no
  // writer adds one (only the merge driver, which writes no prepared bytes).
  const before = receiptConflicts(prior).map((c) => c.text);
  const after = receiptConflicts(next).map((c) => c.text);
  if (before.length === after.length && before.every((t, i) => after[i] === t)) return;
  refuse("receipts_immutable", `${label(next)}: receipt conflicts are cleared only by \`storybloq resolve --receipt\` or \`--receipt-conflict\`, one at a time.`);
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const digestsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : []);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The canonical texts of an append-only field, `[]` when absent; anything else is refused. */
function elementTexts(field: string, who: string, t: Raw | null, next: Raw): string[] {
  const v = t?.[field];
  if (v === undefined) return [];
  if (!Array.isArray(v)) refuse("receipts_immutable", `${label(next)}: the ${who} ${field} is not an array; a resolution never touches it. Repair it by hand.`);
  return texts(field, who, v, next);
}

/**
 * 3.6: a resolution is one transition, checked against the record on disk.
 * Anything it did not name (a receipt appended by another writer after the
 * resolver read the record, another conflict, another field) is unchanged.
 */
function assertResolutionTransition(prior: Raw | null, next: Raw): void {
  const no = (why: string): never => refuse("receipts_immutable", `${label(next)}: a resolution ${why}; nothing was written.`);

  // Exactly one receipt conflict leaves, the rest stay in order.
  const before = receiptConflicts(prior);
  const after = receiptConflicts(next);
  if (after.length !== before.length - 1) no("clears exactly one receipt conflict");
  const gone = before.findIndex((c, i) => after[i]?.text !== c.text);
  const removedAt = gone === -1 ? before.length - 1 : gone;
  if (!after.every((c, i) => c.text === before[i < removedAt ? i : i + 1]!.text)) no("clears one receipt conflict and keeps every other conflict unchanged");
  const conflict = before[removedAt]!.raw;
  const kind = String(conflict.kind);
  const field = typeof conflict.field === "string" ? conflict.field : "receipts";
  if (!APPEND_ONLY_FIELDS.includes(field) || field === "receiptResolutions") no(`cannot act on field ${JSON.stringify(field)}`);

  // Exactly one history entry, naming that conflict, appended at the end.
  const hBefore = elementTexts("receiptResolutions", "current", prior, next);
  const hAfter = elementTexts("receiptResolutions", "new", next, next);
  if (hAfter.length !== hBefore.length + 1 || !hBefore.every((t, i) => hAfter[i] === t)) no("appends exactly one history entry and keeps the history unchanged");
  const entry = (next.receiptResolutions as unknown[])[hBefore.length];
  if (!isRecord(entry) || typeof entry.id !== "string" || !RESOLUTION_ID_REGEX.test(entry.id) || resolutionEntryId(entry) !== entry.id) {
    no("appends a history entry carrying its rr- id");
  }
  const e = entry as Record<string, unknown>;
  if (e.kind !== kind || e.conflictId !== conflict.id || (e.field ?? "receipts") !== field) no("appends the history entry of the conflict it clears");

  // Every other append-only field is unchanged.
  for (const other of APPEND_ONLY_FIELDS) {
    if (other === "receiptResolutions" || other === field) continue;
    if (canonical(prior?.[other]) !== canonical(next[other])) no(`never changes ${other}`);
  }

  // In the conflict's field: removals only, in order, of named bodies the history keeps.
  const fBefore = elementTexts(field, "current", prior, next);
  const fAfter = elementTexts(field, "new", next, next);
  if (prior?.[field] === undefined && next[field] !== undefined) no(`never adds ${field}`);
  if (prior?.[field] !== undefined && next[field] === undefined) no(`never removes ${field}`);
  const named = new Set([...digestsOf(conflict.base), ...digestsOf(conflict.ours), ...digestsOf(conflict.theirs)]);
  const bodies = isRecord(e.bodies) ? e.bodies : {};
  const kept = new Set(["base", "ours", "theirs"].flatMap((side) => (Array.isArray(bodies[side]) ? (bodies[side] as unknown[]) : []).map((b) => canonical(b))));
  const removable = kind === "receipt" && (e.keep === "ours" || e.keep === "theirs");
  let j = 0;
  for (const text of fBefore) {
    if (j < fAfter.length && fAfter[j] === text) {
      j++;
      continue;
    }
    if (!removable) no(`keeping ${String(e.keep)} removes nothing from ${field}`);
    if (!named.has(digest(text))) no(`removes only the bodies its conflict names from ${field}; an element it did not name is kept`);
    if (!kept.has(text)) no(`removes a body only when its history entry keeps it`);
  }
  if (j !== fAfter.length) no(`never adds, alters or reorders an element of ${field}`);
  if (removable) {
    const chosen = digestsOf(conflict[e.keep as "ours" | "theirs"]);
    if (chosen.length !== 1 || !fAfter.some((text) => digest(text) === chosen[0])) no(`keeps the ${String(e.keep)} body of ${String(conflict.id)}`);
  }
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
