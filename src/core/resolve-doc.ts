import type { ConflictEntry } from "../models/types.js";
import { fieldName, isEntityLevel, isReservedKey, selectConflicts, type CatalogSelectScope, type ResolveOptions, type ResolveResult } from "./resolve.js";

/**
 * Conflict resolution for config.json / roadmap.json (ISS-749).
 *
 * Unlike entity resolution (top-level fields only), document conflicts carry
 * nested JSON-Pointer fieldPaths, keyed-array element aliases
 * (e.g. "phases[id=p2]") and id-order reorder entries. Application is by
 * location, never by blind top-level assignment.
 *
 * Two hardening layers (ISS-768/ISS-769) shape everything below. _conflicts
 * entries arrive from merges of teammate branches and are UNTRUSTED input:
 * (1) pointer segments never traverse prototype keys (ISS-768), and
 * (2) pointer fieldPaths carry MERGE-TIME array indices, so pointer ops are
 *     captured against the pre-mutation document and applied afterwards by
 *     element identity; every ambiguity refuses loudly instead of guessing
 *     (ISS-769).
 */

const KEYED_ALIAS_REGEX = /^(.+)\[([^=\]]+)=(.+)\]$/;

/** RFC 6901 pointer segments; a legacy bare fieldPath is one top-level segment. */
function parsePointer(fieldPath: string): string[] {
  const segments = !fieldPath.startsWith("/")
    ? [fieldPath]
    : fieldPath
        .slice(1)
        .split("/")
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  // ISS-768: exact segment equality only, applied AFTER ~-unescaping, so
  // benign fields like "prototypeSettings" are untouched.
  for (const seg of segments) {
    if (isReservedKey(seg)) {
      throw new Error(
        `Cannot apply conflict resolution at "${fieldPath}": pointer segment "${seg}" is a reserved prototype key ` +
        `(_conflicts entries are untrusted input and never traverse prototypes). Resolve by hand and re-run, or use --value.`,
      );
    }
  }
  return segments;
}

function pointerError(fieldPath: string): Error {
  return new Error(
    `Cannot apply conflict resolution at "${fieldPath}": the container is missing or the index is out of range ` +
    `(the document may have been hand-edited since the merge). Resolve by hand and re-run, or use --value.`,
  );
}

interface KeyedTarget {
  arr: unknown[];
  keyField: string;
  keyValue: string;
  recordedIndex: number;
}

function keyedTarget(doc: Record<string, unknown>, c: ConflictEntry): KeyedTarget {
  const alias = fieldName(c);
  const match = KEYED_ALIAS_REGEX.exec(alias)!;
  const [, , keyField, keyValue] = match;
  const segments = parsePointer(c.fieldPath);
  const recordedIndex = Number(segments[segments.length - 1]);
  const containerSegments = segments.slice(0, -1);
  let current: unknown = doc;
  for (const seg of containerSegments) {
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else if (Array.isArray(current)) {
      current = current[Number(seg)];
    } else {
      throw pointerError(c.fieldPath);
    }
  }
  if (!Array.isArray(current)) throw pointerError(c.fieldPath);
  return { arr: current, keyField: keyField!, keyValue: keyValue!, recordedIndex: Number.isInteger(recordedIndex) ? recordedIndex : 0 };
}

/** Locates an element by key (robust to index drift); -1 when absent. */
function keyedIndexOf(target: KeyedTarget): number {
  return target.arr.findIndex(
    (el) => typeof el === "object" && el !== null && (el as Record<string, unknown>)[target.keyField] === target.keyValue,
  );
}

/**
 * Same-batch mutation bookkeeping (ISS-769): keyed replacements and pointer
 * sets record old-element -> new-value edges; keyed deletes and pointer
 * deletes record removals. Only object nodes are recorded: primitives have no
 * identity, so value-keyed entries would alias unrelated equal values.
 */
interface ApplyBook {
  removed: Set<unknown>;
  replaced: Map<unknown, unknown>;
}

function applyKeyedElement(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown, book: ApplyBook): void {
  const target = keyedTarget(doc, c);
  const idx = keyedIndexOf(target);

  if (chosen === undefined) {
    // Chosen side deleted the element.
    if (idx >= 0) {
      const old = target.arr[idx];
      if (typeof old === "object" && old !== null) book.removed.add(old);
      target.arr.splice(idx, 1);
    }
    return;
  }

  if (typeof chosen !== "object" || chosen === null) {
    throw new Error(
      `Conflict "${fieldName(c)}": the chosen side is not an element object. Resolve with --value '<element JSON>'.`,
    );
  }

  if (idx >= 0) {
    const old = target.arr[idx];
    if (typeof old === "object" && old !== null) book.replaced.set(old, chosen);
    target.arr[idx] = chosen;
    return;
  }
  if (c.kind === "delete-edit") {
    // Element missing (already removed): restore at the recorded index, clamped.
    const insertAt = Math.max(0, Math.min(target.recordedIndex, target.arr.length));
    target.arr.splice(insertAt, 0, chosen);
    return;
  }
  throw new Error(
    `Conflict "${fieldName(c)}": no element with ${target.keyField}="${target.keyValue}" exists in the document ` +
    `(hand-edited since the merge?). Resolve by hand and re-run, or use --value.`,
  );
}

/**
 * Reorder entries record id-string arrays for each side (the keyed-array
 * order conflict). Application reorders the EXISTING merged elements --
 * preserving their cleanly merged content, never replacing elements -- to the
 * chosen side's id order. Elements in the doc missing from the chosen order
 * append at the end in current relative order; ids in the order missing from
 * the doc are skipped.
 */
function isReorderEntry(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown): boolean {
  if (!Array.isArray(chosen) || !chosen.every((v) => typeof v === "string")) return false;
  const segments = parsePointer(c.fieldPath);
  let current: unknown = doc;
  for (const seg of segments) {
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return false;
    }
  }
  return Array.isArray(current) && current.length > 0 &&
    current.every((el) => typeof el === "object" && el !== null);
}

function applyReorder(doc: Record<string, unknown>, c: ConflictEntry, chosenOrder: string[]): void {
  const segments = parsePointer(c.fieldPath);
  let parent: unknown = doc;
  for (const seg of segments.slice(0, -1)) {
    // isReorderEntry validated this walk at PLAN time, but applyPlanned applies
    // entity-level ops first, so a same-batch entity replacement can turn a
    // mid-walk node into a non-object between classification and application.
    // Refuse loudly (pointerError) rather than dereferencing a primitive.
    if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
      throw pointerError(c.fieldPath);
    }
    parent = (parent as Record<string, unknown>)[seg];
  }
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
    throw pointerError(c.fieldPath);
  }
  const key = segments[segments.length - 1]!;
  const arr = (parent as Record<string, unknown>)[key] as Array<Record<string, unknown>>;
  // Same desync guard for the final target: a same-batch entity op may have
  // replaced the array itself with a non-array (arr.every would TypeError).
  if (!Array.isArray(arr)) {
    throw pointerError(c.fieldPath);
  }
  // Element-shape guard: the same desync can leave the array holding null,
  // primitives, or nested arrays, all of which would bare-TypeError on the
  // el.id / el.name shape access below. Refuse loudly instead.
  if (!arr.every((el) => typeof el === "object" && el !== null && !Array.isArray(el))) {
    throw pointerError(c.fieldPath);
  }

  const keyField = arr.every((el) => typeof el.id === "string") ? "id"
    : arr.every((el) => typeof el.name === "string") ? "name"
    : null;
  if (!keyField) {
    throw new Error(
      `Cannot reorder "${c.fieldPath}": elements have no common string "id" or "name" key. Resolve by hand.`,
    );
  }

  const original = [...arr];
  const byKey = new Map(original.map((el) => [el[keyField] as string, el]));
  const result: Array<Record<string, unknown>> = [];
  const placed = new Set<string>();
  for (const id of chosenOrder) {
    const el = byKey.get(id);
    if (el) {
      result.push(el);
      placed.add(id);
    }
    // ids missing from the doc are skipped
  }
  for (const el of original) {
    const k = el[keyField] as string;
    if (!placed.has(k)) result.push(el); // doc-only elements append in current relative order
  }
  // IN PLACE, element references preserved: captured pointer targets (ISS-769)
  // must keep pointing at this same array object across the reorder. No spread
  // (argument-limit safe on large arrays); reorder never removes elements, so
  // it contributes nothing to the ApplyBook.
  arr.length = 0;
  for (const el of result) arr.push(el);
}

type PlannedOp =
  | { op: "entity"; c: ConflictEntry; chosen: unknown }
  | { op: "reorder"; c: ConflictEntry; chosen: string[] }
  | { op: "keyed"; c: ConflictEntry; chosen: unknown }
  | { op: "pointer-set"; c: ConflictEntry; chosen: unknown }
  | { op: "pointer-delete"; c: ConflictEntry };

function planOp(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown): PlannedOp {
  if (isEntityLevel(c)) return { op: "entity", c, chosen };
  if (KEYED_ALIAS_REGEX.test(fieldName(c))) return { op: "keyed", c, chosen };
  if (isReorderEntry(doc, c, chosen)) return { op: "reorder", c, chosen: chosen as string[] };
  if (chosen === undefined) return { op: "pointer-delete", c };
  return { op: "pointer-set", c, chosen };
}

function applyEntityLevelDoc(doc: Record<string, unknown>, c: ConflictEntry, chosen: unknown, side: "ours" | "theirs" | undefined): void {
  if (
    chosen === null || chosen === undefined || typeof chosen !== "object" || Array.isArray(chosen) ||
    Object.keys(chosen as Record<string, unknown>).length === 0
  ) {
    throw new Error(
      `Side "${side ?? "value"}" of this conflict has no recoverable content; ` +
      `use --use ${side === "ours" ? "theirs" : "ours"} or resolve by hand with --value '<full document JSON>'.`,
    );
  }
  for (const k of Object.keys(doc)) {
    if (k !== "_conflicts") delete doc[k];
  }
  for (const [k, v] of Object.entries(chosen as Record<string, unknown>)) {
    if (k !== "_conflicts" && !isReservedKey(k)) doc[k] = v;
  }
}

/**
 * ISS-769 capture/apply machinery. Pointer ops are captured against the
 * post-entity, pre-reorder/keyed document (where merge-time indices are still
 * valid), binding each numeric segment to the element it referenced. They are
 * applied after array mutation by re-walking from the root with identity
 * lookups. Refusal ladder on every ambiguity: never guess, never write to a
 * detached node, never mark a conflict resolved on a write that did not land.
 */
type CapturedStep =
  | { kind: "key"; seg: string; node: unknown }
  | { kind: "index"; seg: number; elem: unknown; keyed?: { keyField: string; keyValue: string } | "ambiguous"; keyedOpsPresent: boolean };

interface CapturedPointerOp {
  op: "pointer-set" | "pointer-delete";
  fieldPath: string;
  chosen?: unknown;
  steps: CapturedStep[];
}

/** Keyed-op aliases per array pointer path (defense in depth for relocation). */
function keyedMetaByArrayPath(ops: PlannedOp[]): Map<string, Array<{ keyField: string; keyValue: string }>> {
  const map = new Map<string, Array<{ keyField: string; keyValue: string }>>();
  for (const op of ops) {
    if (op.op !== "keyed") continue;
    const match = KEYED_ALIAS_REGEX.exec(fieldName(op.c));
    if (!match) continue;
    const segments = parsePointer(op.c.fieldPath);
    const key = JSON.stringify(segments.slice(0, -1));
    const list = map.get(key) ?? [];
    list.push({ keyField: match[2]!, keyValue: match[3]! });
    map.set(key, list);
  }
  return map;
}

function capturePointerOp(
  doc: Record<string, unknown>,
  op: "pointer-set" | "pointer-delete",
  c: ConflictEntry,
  chosen: unknown,
  keyedMeta: Map<string, Array<{ keyField: string; keyValue: string }>>,
): CapturedPointerOp {
  const fieldPath = c.fieldPath;
  const segments = parsePointer(fieldPath);
  if (segments.length === 0) throw pointerError(fieldPath);
  const steps: CapturedStep[] = [];
  let current: unknown = doc;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isFinal = i === segments.length - 1;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) throw pointerError(fieldPath);
      const elem: unknown = current[idx];
      const entries = keyedMeta.get(JSON.stringify(segments.slice(0, i))) ?? [];
      const matched = new Map<string, { keyField: string; keyValue: string }>();
      if (typeof elem === "object" && elem !== null) {
        for (const e of entries) {
          if ((elem as Record<string, unknown>)[e.keyField] === e.keyValue) {
            matched.set(`${e.keyField}=${e.keyValue}`, e);
          }
        }
      }
      const step: CapturedStep = { kind: "index", seg: idx, elem, keyedOpsPresent: entries.length > 0 };
      if (matched.size === 1) step.keyed = [...matched.values()][0];
      else if (matched.size > 1) step.keyed = "ambiguous";
      steps.push(step);
      current = elem;
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      // Mid-walk segments must be OWN properties (ISS-768 defense in depth);
      // the final segment may be a new key (set) or absent (delete no-op).
      if (!isFinal && !Object.hasOwn(obj, seg)) throw pointerError(fieldPath);
      steps.push({ kind: "key", seg, node: obj[seg] });
      current = obj[seg];
    } else {
      throw pointerError(fieldPath);
    }
  }
  return { op, fieldPath, chosen, steps };
}

/** Whole-array scan requiring at most one === match; -2 signals ambiguity. */
function locateUnique(arr: unknown[], value: unknown): number {
  let found = -1;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === value) {
      count += 1;
      if (found < 0) found = i;
    }
  }
  return count > 1 ? -2 : found;
}

/** Unique lookup by key field; more than one match refuses. */
function uniqueIndexByField(arr: unknown[], field: string, value: unknown, fieldPath: string): number {
  let found = -1;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    if (typeof el === "object" && el !== null && (el as Record<string, unknown>)[field] === value) {
      count += 1;
      if (found < 0) found = i;
    }
  }
  if (count > 1) throw pointerError(fieldPath);
  return found;
}

/** Follows same-batch replacement edges; a cycle (crafted input) refuses. */
function chainHead(replaced: Map<unknown, unknown>, start: unknown, fieldPath: string): unknown {
  const seen = new Set<unknown>([start]);
  let cur = start;
  while (replaced.has(cur)) {
    cur = replaced.get(cur);
    if (seen.has(cur)) throw pointerError(fieldPath);
    seen.add(cur);
  }
  return cur;
}

type Located = { idx: number; node: unknown; moved: boolean } | "gone";

/**
 * Resolves a captured index step against the CURRENT array. Ladder:
 * (1) reference identity (aliased duplicates refuse);
 * (2) same-batch replacement chain (cycle-guarded);
 * (3) keyed metadata recorded at capture (ambiguity marker refuses);
 * (4) id/name heuristic, only when the array had no keyed ops in the batch;
 * (5) a FINAL delete whose element was genuinely removed reports "gone";
 * (6) otherwise refuse.
 */
function locateElement(arr: unknown[], step: Extract<CapturedStep, { kind: "index" }>, book: ApplyBook, fieldPath: string, forFinalDelete: boolean): Located {
  const elem = step.elem;
  // Primitive elements have no identity: apply at the recorded index guarded
  // by a value check. Primitive arrays are unreachable by reorder/keyed stages
  // (both require object elements), so a mismatch means same-batch sibling
  // drift: refuse rather than guess (duplicates make indexOf wrong).
  if (typeof elem !== "object" || elem === null) {
    if (step.seg < arr.length && arr[step.seg] === elem) return { idx: step.seg, node: elem, moved: false };
    throw pointerError(fieldPath);
  }
  let idx = locateUnique(arr, elem);
  if (idx === -2) throw pointerError(fieldPath);
  if (idx >= 0) return { idx, node: elem, moved: false };
  const head = chainHead(book.replaced, elem, fieldPath);
  if (head !== elem) {
    idx = locateUnique(arr, head);
    if (idx === -2) throw pointerError(fieldPath);
    if (idx >= 0) return { idx, node: head, moved: true };
  }
  if (step.keyed === "ambiguous") throw pointerError(fieldPath);
  if (step.keyed) {
    idx = uniqueIndexByField(arr, step.keyed.keyField, step.keyed.keyValue, fieldPath);
    if (idx >= 0) return { idx, node: arr[idx], moved: true };
  }
  if (!step.keyedOpsPresent) {
    const el = elem as Record<string, unknown>;
    const hkey = typeof el.id === "string" ? "id" : typeof el.name === "string" ? "name" : null;
    if (hkey) {
      idx = uniqueIndexByField(arr, hkey, el[hkey], fieldPath);
      if (idx >= 0) return { idx, node: arr[idx], moved: true };
    }
  }
  if (forFinalDelete && (book.removed.has(elem) || book.removed.has(head))) return "gone";
  throw pointerError(fieldPath);
}

function applyCapturedOp(doc: Record<string, unknown>, cap: CapturedPointerOp, book: ApplyBook): void {
  let current: unknown = doc;
  let moved = false;
  const steps = cap.steps;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]!;
    if (step.kind === "index") {
      if (!Array.isArray(current)) throw pointerError(cap.fieldPath);
      const located = locateElement(current, step, book, cap.fieldPath, false) as Exclude<Located, "gone">;
      moved = moved || located.moved;
      current = located.node;
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) throw pointerError(cap.fieldPath);
      const obj = current as Record<string, unknown>;
      if (!Object.hasOwn(obj, step.seg)) throw pointerError(cap.fieldPath);
      const next = obj[step.seg];
      // Outside a relocated subtree the reached node must BE the captured one:
      // a mismatch means an unrelated same-batch op swapped this ancestor
      // (untrusted overlap); refuse rather than write into the swap. Inside a
      // relocated subtree (the user's chosen replacement) keys are followed
      // by name; that subtree is legitimately different.
      if (!moved && next !== step.node) throw pointerError(cap.fieldPath);
      current = next;
    }
  }
  const last = steps[steps.length - 1]!;
  if (last.kind === "index") {
    if (!Array.isArray(current)) throw pointerError(cap.fieldPath);
    const arr = current;
    if (cap.op === "pointer-set") {
      const located = locateElement(arr, last, book, cap.fieldPath, false) as Exclude<Located, "gone">;
      // Aliasing guard: a chosen OBJECT already present elsewhere in this
      // array would poison every later identity lookup in the batch.
      // Primitive chosen values are legitimate duplicate content.
      if (typeof cap.chosen === "object" && cap.chosen !== null) {
        const j = locateUnique(arr, cap.chosen);
        if (j === -2 || (j >= 0 && j !== located.idx)) throw pointerError(cap.fieldPath);
      }
      arr[located.idx] = cap.chosen;
      if (typeof located.node === "object" && located.node !== null) book.replaced.set(located.node, cap.chosen);
    } else {
      const located = locateElement(arr, last, book, cap.fieldPath, true);
      if (located === "gone") return;
      arr.splice(located.idx, 1);
      if (typeof located.node === "object" && located.node !== null) book.removed.add(located.node);
    }
  } else {
    if (typeof current !== "object" || current === null || Array.isArray(current)) throw pointerError(cap.fieldPath);
    const obj = current as Record<string, unknown>;
    if (cap.op === "pointer-set") {
      obj[last.seg] = cap.chosen;
    } else {
      delete obj[last.seg];
    }
  }
}

/** Descending recorded index, so earlier splices never shift later targets. */
function capturedDeleteIndex(cap: CapturedPointerOp): number {
  const last = cap.steps[cap.steps.length - 1]!;
  return last.kind === "index" ? last.seg : -1;
}

function applyPlanned(doc: Record<string, unknown>, ops: PlannedOp[], side: "ours" | "theirs" | undefined): void {
  // Bulk application order (ISS-769): entity-level first; pointer ops are then
  // CAPTURED while merge-time indices are still valid; reorder (in-place) and
  // keyed stages mutate array shape; captured sets apply by element identity;
  // captured pointer-index DELETIONS go last in descending recorded order.
  const book: ApplyBook = { removed: new Set(), replaced: new Map() };
  for (const op of ops) {
    if (op.op === "entity") applyEntityLevelDoc(doc, op.c, op.chosen, side);
  }
  const keyedMeta = keyedMetaByArrayPath(ops);
  const capturedSets: CapturedPointerOp[] = [];
  const capturedDeletes: CapturedPointerOp[] = [];
  for (const op of ops) {
    if (op.op === "pointer-set") capturedSets.push(capturePointerOp(doc, "pointer-set", op.c, op.chosen, keyedMeta));
    else if (op.op === "pointer-delete") capturedDeletes.push(capturePointerOp(doc, "pointer-delete", op.c, undefined, keyedMeta));
  }
  for (const op of ops) {
    if (op.op === "reorder") applyReorder(doc, op.c, op.chosen);
  }
  for (const op of ops) {
    if (op.op === "keyed") applyKeyedElement(doc, op.c, op.chosen, book);
  }
  for (const cap of capturedSets) applyCapturedOp(doc, cap, book);
  const sortedDeletes = [...capturedDeletes].sort((a, b) => capturedDeleteIndex(b) - capturedDeleteIndex(a));
  for (const cap of sortedDeletes) applyCapturedOp(doc, cap, book);
}

/** C-v4.1 2.3: the one way out of a `board-identity` conflict. */
export const BOARD_IDENTITY_RESOLVE_HINT =
  "The board identity conflict is not resolved by picking a side: the board id never changes by merge. " +
  "Run `storybloq board-id adopt <b-id>` to choose the id this clone keeps.";

export function resolveDocConflicts(
  doc: Record<string, unknown>,
  options: ResolveOptions,
): ResolveResult {
  const conflicts = doc._conflicts as ConflictEntry[] | undefined;
  if (!conflicts || conflicts.length === 0) {
    return { resolved: [], remaining: 0, fullyResolved: true, warnings: [], messages: [] };
  }

  const resolved: string[] = [];
  const remaining: ConflictEntry[] = [];
  const warnings: string[] = [];
  const messages: string[] = [];

  if (options.field) {
    // T-529: the shared selection rule; config and roadmap resolve the one
    // record it names (they register no coupled groups).
    const target = selectConflicts(conflicts, { field: options.field }).target;
    if (target.kind === "board-identity") throw new Error(BOARD_IDENTITY_RESOLVE_HINT);
    // ISS-758 guard: an explicit choice is required.
    if (options.value === undefined && !options.use) {
      throw new Error(
        `--field "${options.field}" requires --use ours|theirs or --value. ` +
        `Example: storybloq resolve <id> --field ${options.field} --use theirs`,
      );
    }
    const hasValue = options.value !== undefined;
    const chosen = hasValue
      ? options.value
      : options.use === "ours" ? target.ours : target.theirs;
    applyPlanned(doc, [planOp(doc, target, chosen)], options.use);
    resolved.push(fieldName(target) || "_entity");
    for (const c of conflicts) {
      if (c !== target) remaining.push(c);
    }
  } else if (options.use) {
    const side = options.use;
    // C-v4.1 2: a board identity conflict is never settled by picking a side.
    const identity = conflicts.filter((c) => c.kind === "board-identity");
    const settle = conflicts.filter((c) => c.kind !== "board-identity");
    const ops = settle.map((c) => planOp(doc, c, side === "ours" ? c.ours : c.theirs));
    applyPlanned(doc, ops, side);
    for (const c of settle) {
      resolved.push(fieldName(c) || "_entity");
    }
    if (identity.length > 0) {
      remaining.push(...identity);
      messages.push(BOARD_IDENTITY_RESOLVE_HINT);
    }
  } else {
    throw new Error("Must specify --use or --field");
  }

  if (remaining.length === 0) {
    delete doc._conflicts;
  } else {
    doc._conflicts = remaining;
  }

  return {
    resolved,
    remaining: remaining.length,
    fullyResolved: remaining.length === 0,
    warnings,
    messages,
  };
}

/** T-529: a catalog resolution's options: the entity forms plus the entry and group scopes. */
export interface CatalogResolveOptions extends ResolveOptions {
  readonly entityId?: string;
  readonly group?: string;
}

export interface CatalogResolveScope extends CatalogSelectScope {
  /** The file, for messages: "capabilities.json" or "glossary.json". */
  readonly file: string;
  /**
   * Called before a chosen side removes an entry. Throws to refuse: a
   * capability is never deleted by a resolution, and a term is not deleted
   * while a capability references it.
   */
  readonly guardDelete: (entryId: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901 escaping for one pointer segment. */
function pointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The one element whose id is `entryId`: -1 when absent, a refusal when there are two. */
function entryIndex(arr: unknown[], entryId: string, file: string): number {
  let found = -1;
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    if (isPlainObject(el) && el.id === entryId) {
      if (found >= 0) {
        throw new Error(`Cannot resolve: two entries in ${file} have the id "${entryId}". Resolve by hand.`);
      }
      found = i;
    }
  }
  return found;
}

/**
 * A group record's chosen side, as pointer ops on the entry's CURRENT index.
 * The payload is untrusted (it arrived with a teammate's branch): it must be a
 * plain object whose keys are all registered members. For every registered
 * member, a key the payload lacks (or holds as undefined) is deleted from the
 * entry, an explicit null is written as null, and any other value is written
 * as is. Fields outside the group are never touched.
 */
function groupOps(
  c: ConflictEntry,
  chosen: unknown,
  index: number,
  scope: CatalogResolveScope,
): PlannedOp[] {
  const group = scope.groups.find((g) => g.group === c.group);
  if (!group) {
    throw new Error(`Cannot resolve: "${String(c.group)}" is not a group of ${scope.file}'s entries. Resolve by hand.`);
  }
  if (!isPlainObject(chosen)) {
    throw new Error(`Cannot resolve the "${group.group}" group of "${String(c.entityId)}": the chosen side is not an object of group members. Resolve by hand.`);
  }
  for (const key of Object.keys(chosen)) {
    if (!group.members.includes(key)) {
      throw new Error(
        `Cannot resolve the "${group.group}" group of "${String(c.entityId)}": the chosen side carries "${key}", ` +
        `which is not a member of the group (the record is not trusted). Resolve by hand.`,
      );
    }
  }
  const ops: PlannedOp[] = [];
  for (const member of group.members) {
    const value = Object.hasOwn(chosen, member) ? chosen[member] : undefined;
    const entry: ConflictEntry = {
      fieldPath: `/${scope.key}/${index}/${pointerSegment(member)}`,
      kind: "field",
      base: undefined,
      ours: undefined,
      theirs: undefined,
    };
    ops.push(value === undefined ? { op: "pointer-delete", c: entry } : { op: "pointer-set", c: entry, chosen: value });
  }
  return ops;
}

/**
 * T-529: resolution for capabilities.json and glossary.json, everything but
 * the invariant records (which have their own resolvers).
 *
 * A record that names an entry (`entityId`) is applied to that entry where it
 * is NOW, found by id, never at the index the merge recorded: a later insert
 * may have moved it. A record for a whole entry (an add/add or a delete/edit)
 * goes through the keyed element path, which already locates by id. Records
 * with no entry (the version, the order, a whole-document fallback) go
 * through the document path unchanged. A bare `--use` applies every
 * non-invariant record; the invariant ones stay for `--invariant`.
 */
export function resolveCatalogConflicts(
  doc: Record<string, unknown>,
  options: CatalogResolveOptions,
  scope: CatalogResolveScope,
): ResolveResult {
  const conflicts = (doc._conflicts as ConflictEntry[] | undefined) ?? [];
  const nonInvariant = conflicts.filter((c) => c.kind !== "invariant");
  if (nonInvariant.length === 0) {
    const pending = conflicts.length;
    if (pending > 0) {
      throw new Error(
        `${scope.file} has only invariant conflicts; resolve each with \`storybloq resolve ${scope.file} --invariant <n> ...\` ` +
        `(the numbers \`storybloq conflicts show ${scope.file}\` prints).`,
      );
    }
    return { resolved: [], remaining: 0, fullyResolved: true, warnings: [], messages: [] };
  }

  let selected: ConflictEntry[];
  if (options.group !== undefined && options.entityId === undefined) {
    throw new Error(`--group needs --id <entry id>: a group conflict belongs to one entry.`);
  }
  if (options.entityId !== undefined || options.field !== undefined || options.group !== undefined) {
    selected = selectConflicts(conflicts, {
      field: options.field,
      group: options.group,
      entityId: options.entityId,
      catalog: scope,
    }).selected;
  } else if (options.use) {
    selected = nonInvariant;
  } else {
    throw new Error("Must specify --use or --field");
  }

  if (options.value !== undefined) {
    if (selected.some((c) => c.kind === "coupled")) {
      throw new Error(
        `Cannot use --value on a coupled group: a group is resolved whole. Use --use ours|theirs.`,
      );
    }
    if (options.field === undefined || selected.length !== 1) {
      throw new Error(`--value sets one field: name it with --field (and the entry with --id).`);
    }
  } else if (!options.use) {
    throw new Error(
      `--field "${options.field}" requires --use ours|theirs or --value. ` +
      `Example: storybloq resolve ${scope.file} --id <id> --field ${options.field} --use theirs`,
    );
  }

  const chosenFor = (c: ConflictEntry): unknown =>
    options.value !== undefined ? options.value : options.use === "ours" ? c.ours : c.theirs;
  const resolved: string[] = [];

  // A whole-document record replaces every entry, so it goes first, and the
  // entries the other records name are located in what it leaves.
  const wholeDocument = selected.filter((c) => c.entityId === undefined && isEntityLevel(c));
  if (wholeDocument.length > 0) {
    applyPlanned(doc, wholeDocument.map((c) => planOp(doc, c, chosenFor(c))), options.use);
    resolved.push(...wholeDocument.map((c) => fieldName(c) || "_entity"));
  }

  const arr = doc[scope.key];
  const entries = Array.isArray(arr) ? arr : [];
  const ops: PlannedOp[] = [];
  for (const c of selected) {
    if (wholeDocument.includes(c)) continue;
    const chosen = chosenFor(c);
    if (c.entityId === undefined) {
      ops.push(planOp(doc, c, chosen));
      resolved.push(fieldName(c) || "_entity");
      continue;
    }
    const entryId = c.entityId;
    // The record is untrusted: its path must be one entry of this catalog
    // (a whole entry, or a field under one), a whole-entry record's alias must
    // name the entry its entityId names, and every target is located by that
    // id in the document as it is now, never at the recorded index.
    const path = new RegExp(`^/${scope.key}/(\\d+)(/.+)?$`).exec(c.fieldPath);
    const untrusted = (): Error => new Error(
      `Cannot resolve: a conflict for entry "${entryId}" has a path or alias that does not describe that entry ` +
      `(the record is not trusted). Resolve by hand.`,
    );
    if (!path || isEntityLevel(c)) throw untrusted();
    const rest = path[2];
    const index = entryIndex(entries, entryId, scope.file);
    if (rest === undefined && (c.kind === "array-element" || c.kind === "delete-edit")) {
      if (fieldName(c) !== `${scope.key}[id=${entryId}]`) throw untrusted();
      if (chosen === undefined) {
        scope.guardDelete(entryId);
      } else if (!isPlainObject(chosen) || chosen.id !== entryId) {
        throw new Error(`Cannot resolve "${entryId}": the chosen side is not that entry. Resolve by hand.`);
      }
      // The keyed path finds the entry by this id (restoring a deleted one at
      // the recorded position, clamped); the alias was checked above.
      ops.push({ op: "keyed", c, chosen });
      resolved.push(entryId);
      continue;
    }
    if (index < 0) {
      throw new Error(
        `Cannot resolve: a conflict names entry "${entryId}", which is not in ${scope.file} ` +
        `(hand-edited since the merge?). Resolve by hand and re-run.`,
      );
    }
    if (rest === undefined && c.kind === "coupled") {
      ops.push(...groupOps(c, chosen, index, scope));
      resolved.push(`${entryId}: ${String(c.group)}`);
      continue;
    }
    if (rest === undefined || (c.kind !== "field" && c.kind !== "delete-edit") || KEYED_ALIAS_REGEX.test(fieldName(c))) {
      throw untrusted();
    }
    // Built here, not by planOp: planOp classifies by the alias, and this
    // record's alias is not trusted to pick the operation.
    const target: ConflictEntry = { ...c, fieldPath: `/${scope.key}/${index}${rest}` };
    ops.push(chosen === undefined ? { op: "pointer-delete", c: target } : { op: "pointer-set", c: target, chosen });
    resolved.push(`${entryId}: ${fieldName(c)}`);
  }
  applyPlanned(doc, ops, options.use);

  const remaining = conflicts.filter((c) => !selected.includes(c));
  if (remaining.length === 0) delete doc._conflicts;
  else doc._conflicts = remaining;
  const invariants = remaining.filter((c) => c.kind === "invariant").length;
  const messages = invariants > 0
    ? [`${invariants} invariant conflict(s) stay open: resolve each with \`storybloq resolve ${scope.file} --invariant <n> ...\`.`]
    : [];
  return { resolved, remaining: remaining.length, fullyResolved: remaining.length === 0, warnings: [], messages };
}
