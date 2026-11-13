import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { APPEND_ONLY_FIELDS, appendOnlyKeyOf, appendOnlyKeying, resolutionEntryId } from "./append-only-merge.js";
import type { ResolveResult } from "./resolve.js";

/**
 * C-v4.1 3.6: clearing the `receipt` and `receipt-opaque` conflicts that the
 * `append-only-by-id` merge rule writes.
 *
 * - `--receipt <id> --keep ours|theirs` leaves exactly that side's one body
 *   under the id; the body reads `ok` again.
 * - `--keep both` keeps every body; the id then reads `conflicted-kept` for good.
 * - `--receipt-conflict <oc-id>` only clears the entry: an opaque element is
 *   never deleted and never counts either way.
 *
 * Every resolution writes under `MERGE_RESOLUTION_AUTHORITY` (the receipts
 * guard, commit 2, admits these moves only under it) and appends a history
 * entry to `receiptResolutions` carrying every body the conflict named. The
 * entry's `id` is its stable rr- id; `conflictId` names the conflict. The
 * history merges append-only by that id.
 *
 * Keeping one side removes only the keyed bodies the conflict's digests name,
 * classified exactly as the merge classified them: an opaque element that
 * happens to share the id (malformed, or a future version) is never touched.
 */

export const MERGE_RESOLUTION_AUTHORITY: unique symbol = Symbol("receipt-merge-resolution");

export const RECEIPT_KEEP = ["ours", "theirs", "both"] as const;
export type ReceiptKeep = (typeof RECEIPT_KEEP)[number];

/** The kinds the generic `--use`/`--field` paths must never apply as a field value. */
export const RECEIPT_CONFLICT_KINDS: ReadonlySet<string> = new Set(["receipt", "receipt-opaque"]);

export function isReceiptConflict(c: unknown): boolean {
  return c !== null && typeof c === "object" && RECEIPT_CONFLICT_KINDS.has(String((c as { kind?: unknown }).kind));
}

export interface ReceiptResolveOptions {
  /** A `receipt` conflict, by receipt id (rc-) or legacy landing id (lm-). */
  receipt?: string;
  /** A `receipt-opaque` conflict, by its oc- id. */
  receiptConflict?: string;
  keep: string;
  actor?: string;
  label: string;
  now?: () => string;
}

/** Content identity is the canonical form only; an element without one refuses the resolve. */
const digestOf = (element: unknown): string => createHash("sha256").update(canonicalJson(element)).digest("hex");

const asDigests = (v: unknown): string[] => (Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : []);

export function resolveReceiptConflict(
  entity: Record<string, unknown>,
  options: ReceiptResolveOptions,
  authority: typeof MERGE_RESOLUTION_AUTHORITY,
): ResolveResult {
  if (authority !== MERGE_RESOLUTION_AUTHORITY) throw new Error("Receipt conflicts are resolved only under the merge-resolution authority.");
  const keep = options.keep;
  if (!(RECEIPT_KEEP as readonly string[]).includes(keep)) {
    throw new Error(`--keep takes ours, theirs or both (given ${JSON.stringify(keep)}).`);
  }
  // Validated before any receipt body is touched: absent is an empty history,
  // a present non-array value is refused and nothing is written.
  for (const name of APPEND_ONLY_FIELDS) {
    const v = entity[name];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error(`${name} is not an array on ${options.label}; repair it by hand into an array holding every element, then resolve again. Nothing was written.`);
    }
  }
  const opaque = options.receiptConflict !== undefined;
  const wanted = opaque ? options.receiptConflict! : options.receipt!;
  const kind = opaque ? "receipt-opaque" : "receipt";
  const conflicts = (Array.isArray(entity._conflicts) ? entity._conflicts : []) as Record<string, unknown>[];
  const target = conflicts.find((c) => c.kind === kind && c.id === wanted);
  if (!target) {
    throw new Error(`No ${opaque ? "receipt-opaque conflict" : "receipt conflict"} for ${JSON.stringify(wanted)} on ${options.label}.`);
  }
  const field = typeof target.field === "string" ? target.field : "receipts";
  if (!APPEND_ONLY_FIELDS.includes(field)) throw new Error(`Receipt conflict on unknown field ${JSON.stringify(field)}.`);
  const keying = appendOnlyKeying(field);
  const array = Array.isArray(entity[field]) ? (entity[field] as unknown[]) : [];

  // Every body the conflict names, found by digest in the merged array.
  const byDigest = new Map<string, unknown>();
  for (const element of array) {
    if (opaque || appendOnlyKeyOf(element, keying) === wanted) {
      const d = digestOf(element);
      if (!byDigest.has(d)) byDigest.set(d, element);
    }
  }
  const sides = { base: asDigests(target.base), ours: asDigests(target.ours), theirs: asDigests(target.theirs) };
  const bodiesOf = (ds: string[]) => ds.flatMap((d) => (byDigest.has(d) ? [byDigest.get(d)] : []));

  if (!opaque && keep !== "both") {
    const chosen = sides[keep as "ours" | "theirs"];
    if (chosen.length !== 1 || !byDigest.has(chosen[0]!)) {
      throw new Error(
        `Cannot keep ${keep}: ${keep} holds no body for ${wanted}` +
        `${chosen.length > 1 ? ` (it holds ${chosen.length})` : ""}; a receipt is never removed. ` +
        `Use --keep ${keep === "ours" ? "theirs" : "ours"} or --keep both.`,
      );
    }
    const survivor = chosen[0]!;
    const named = new Set([...sides.base, ...sides.ours, ...sides.theirs]);
    let placed = false;
    const next: unknown[] = [];
    for (const element of array) {
      if (appendOnlyKeyOf(element, keying) !== wanted) {
        next.push(element);
        continue;
      }
      const d = digestOf(element);
      if (!named.has(d)) {
        next.push(element);
      } else if (d === survivor && !placed) {
        next.push(element);
        placed = true;
      }
    }
    entity[field] = next;
  }

  const history = Array.isArray(entity.receiptResolutions) ? [...(entity.receiptResolutions as unknown[])] : [];
  const entry: Record<string, unknown> = {
    kind,
    field,
    conflictId: wanted,
    keep,
    bodies: { base: bodiesOf(sides.base), ours: bodiesOf(sides.ours), theirs: bodiesOf(sides.theirs) },
    by: options.actor ?? "unknown",
    at: (options.now ?? (() => new Date().toISOString()))(),
  };
  history.push({ id: resolutionEntryId(entry), ...entry });
  entity.receiptResolutions = history;

  const remaining = conflicts.filter((c) => c !== target);
  if (remaining.length === 0) delete entity._conflicts;
  else entity._conflicts = remaining;
  return {
    resolved: [`${field}/${wanted}`],
    remaining: remaining.length,
    fullyResolved: remaining.length === 0,
    warnings: [],
    messages: [
      keep === "both" && !opaque
        ? `Kept both bodies of ${wanted}; it stays ineligible (conflicted-kept). A new receipt can supersede it.`
        : opaque
          ? `Cleared opaque conflict ${wanted}; the element is kept and never counts.`
          : `Kept the ${keep} body of ${wanted}.`,
    ],
  };
}

/** The resolve line `conflicts show` prints for a receipt conflict. */
export function receiptResolveHint(label: string, c: Record<string, unknown>): string | undefined {
  if (c.kind === "receipt") return `Resolve with: storybloq resolve ${label} --receipt ${String(c.id)} --keep ours|theirs|both`;
  if (c.kind === "receipt-opaque") return `Resolve with: storybloq resolve ${label} --receipt-conflict ${String(c.id)} --keep ours|theirs|both`;
  return undefined;
}
