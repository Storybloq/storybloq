import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { legacyLandingId } from "./legacy-landings.js";
import { ReceiptSchema, receiptElementId } from "./receipts.js";

/**
 * C-v4.1 3.6 (M5, A3, B2): the `append-only-by-id` merge rule, for `receipts`
 * (keyed by receipt id) and `landings` (keyed by the lm- legacy id).
 *
 * Nothing is ever dropped. Elements compare by canonical content
 * (`canonicalJson`), never file bytes.
 * - Union by id: an entry added on one side is kept.
 * - Id conflict: the same id with different bodies, a base entry altered, or a
 *   base entry missing on a side keeps every body and writes a `receipt`
 *   conflict naming the id and each side's body digests.
 * - Opaque elements (receipts with no id, malformed, or a future version) are
 *   unioned by their digest. A base digest missing on a side writes a
 *   `receipt-opaque` conflict whose `oc-` id is derived from the digests only,
 *   so every clone computes the same id.
 * An absent field on every side stays absent; the caller never calls this then.
 */

export type AppendOnlyKey = "receipt" | "landing";

export interface AppendOnlyConflict {
  fieldPath: string;
  field: string;
  kind: "receipt" | "receipt-opaque";
  id: string;
  base: string[];
  ours: string[];
  theirs: string[];
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function pointer(field: string, id: string): string {
  const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
  return `/${esc(field)}/${esc(id)}`;
}

/** The id an element merges under, or undefined when it is opaque. */
function keyOf(element: unknown, keying: AppendOnlyKey): string | undefined {
  if (keying === "landing") {
    if (element === null || typeof element !== "object" || Array.isArray(element)) return undefined;
    return legacyLandingId(element);
  }
  const id = receiptElementId(element);
  if (!id) return undefined;
  const v = (element as { v?: unknown }).v;
  if (typeof v === "number" && v > 1) return undefined;
  return ReceiptSchema.safeParse(element).success ? id : undefined;
}

function canonicalOrString(element: unknown): string {
  try {
    return canonicalJson(element);
  } catch {
    return `unrepresentable:${String(element)}`;
  }
}

interface Side {
  /** Keyed bodies per id, by canonical text, in first-seen order. */
  keyed: Map<string, Map<string, unknown>>;
  /** Opaque elements by digest, in first-seen order. */
  opaque: Map<string, unknown>;
  /** First-seen order of slots ("k:<id>" or "o:<digest>"). */
  order: string[];
}

function sideOf(arr: unknown[], keying: AppendOnlyKey): Side {
  const side: Side = { keyed: new Map(), opaque: new Map(), order: [] };
  for (const element of arr) {
    const text = canonicalOrString(element);
    const id = keyOf(element, keying);
    if (id !== undefined) {
      let bodies = side.keyed.get(id);
      if (!bodies) {
        bodies = new Map();
        side.keyed.set(id, bodies);
        side.order.push(`k:${id}`);
      }
      if (!bodies.has(text)) bodies.set(text, element);
    } else {
      const d = digest(text);
      if (!side.opaque.has(d)) {
        side.opaque.set(d, element);
        side.order.push(`o:${d}`);
      }
    }
  }
  return side;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function mergeAppendOnly(
  field: string,
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  keying: AppendOnlyKey,
): { merged: unknown[]; conflicts: AppendOnlyConflict[] } {
  const b = sideOf(base, keying);
  const o = sideOf(ours, keying);
  const t = sideOf(theirs, keying);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const slot of [...o.order, ...t.order, ...b.order]) {
    if (!seen.has(slot)) {
      seen.add(slot);
      order.push(slot);
    }
  }
  const merged: unknown[] = [];
  const conflicts: AppendOnlyConflict[] = [];
  for (const slot of order) {
    if (slot.startsWith("k:")) {
      const id = slot.slice(2);
      const sides = [b, o, t].map((s) => s.keyed.get(id) ?? new Map<string, unknown>());
      const [bb, ob, tb] = sides as [Map<string, unknown>, Map<string, unknown>, Map<string, unknown>];
      // Every distinct body, ours first, then theirs, then base.
      const union = new Map<string, unknown>();
      for (const m of [ob, tb, bb]) for (const [text, element] of m) if (!union.has(text)) union.set(text, element);
      for (const element of union.values()) merged.push(element);
      const all = new Set(union.keys());
      // Clean when every side holds the full union, or holds nothing while base held nothing.
      const clean = [ob, tb, bb].every((m) => sameSet(new Set(m.keys()), all) || (m.size === 0 && bb.size === 0));
      if (!clean) {
        const digests = (m: Map<string, unknown>) => [...m.keys()].map(digest);
        conflicts.push({ fieldPath: pointer(field, id), field, kind: "receipt", id, base: digests(bb), ours: digests(ob), theirs: digests(tb) });
      }
      continue;
    }
    const d = slot.slice(2);
    const element = o.opaque.get(d) ?? t.opaque.get(d) ?? b.opaque.get(d);
    merged.push(element);
    if (b.opaque.has(d) && (!o.opaque.has(d) || !t.opaque.has(d))) {
      const shape = { base: [d], ours: o.opaque.has(d) ? [d] : [], theirs: t.opaque.has(d) ? [d] : [] };
      const id = `oc-${digest(canonicalJson(shape)).slice(0, 16)}`;
      conflicts.push({ fieldPath: pointer(field, id), field, kind: "receipt-opaque", id, ...shape });
    }
  }
  return { merged, conflicts };
}
