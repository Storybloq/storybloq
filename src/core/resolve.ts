import type { ConflictEntry } from "../models/types.js";
import { APPEND_ONLY_FIELDS } from "./append-only-merge.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * C-v4.1 3.6: a `receipt` or `receipt-opaque` entry is never applied as a field
 * value (its sides are digests, not bodies); `resolve --receipt` clears it.
 */
const RECEIPT_KINDS = new Set(["receipt", "receipt-opaque"]);
const isReceiptKind = (c: ConflictEntry): boolean => RECEIPT_KINDS.has(c.kind);
/** A conflict a generic path must leave alone: a receipt conflict, or any entry on an append-only field. */
const isAppendOnlyConflict = (c: ConflictEntry): boolean =>
  isReceiptKind(c) || (!isEntityLevel(c) && APPEND_ONLY_FIELDS.includes(fieldName(c)));
export const RECEIPT_RESOLVE_HINT = "Receipt conflicts are resolved with `storybloq resolve <id> --receipt <id> --keep ours|theirs|both` (or `--receipt-conflict <oc-id>`).";

export interface ResolveOptions {
  field?: string;
  use?: "ours" | "theirs";
  value?: unknown;
  /** Actor for synthesized attribution (legacy tombstone recovery). */
  actor?: string;
}

export interface ResolveResult {
  resolved: string[];
  remaining: number;
  fullyResolved: boolean;
  /** Advisory messages (e.g. best-effort attribution notes), printed verbatim. */
  warnings: string[];
  /** What happened, for entity-level resolutions (printed on success). */
  messages: string[];
}

/**
 * ISS-768/ISS-801: names that would walk or write the prototype chain when
 * bracket-assigned onto a plain object. Module-private on purpose: only the
 * isReservedKey predicate is exported, so no importer can mutate the
 * canonical set. resolve-doc.ts imports isReservedKey for its pointer guard.
 * _conflicts snapshots arrive from merges of untrusted teammate branches,
 * so these names are never legitimate top-level storybloq fields.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedKey(k: string): boolean {
  return RESERVED_SEGMENTS.has(k);
}

export function fieldName(c: ConflictEntry): string {
  return (c as Record<string, unknown>).field as string | undefined
    ?? c.fieldPath.replace(/^\//, "");
}

export function matchesField(c: ConflictEntry, input: string): boolean {
  if (c.fieldPath === input) return true;
  const plain = input.replace(/^\//, "");
  if (c.fieldPath === `/${plain}`) return true;
  if ((c as Record<string, unknown>).field === plain) return true;
  return false;
}

/**
 * Entity-level (whole entity) conflict entries: the delete-vs-edit snapshots
 * written by the merge driver (kind "delete-edit") and the validation
 * fallback's whole-entity entries (kind "field"). Recognition never keys on
 * `kind` -- the enum is closed and both kinds are semantically whole-entity.
 */
export function isEntityLevel(c: ConflictEntry): boolean {
  return (c as Record<string, unknown>).field === "_entity" || c.fieldPath === "";
}

/** T-529: what a catalog selection needs to know about the file it reads. */
export interface CatalogSelectScope {
  /** The document key holding the entries: "capabilities" or "terms". */
  readonly key: string;
  /** The entry type's registered coupled groups (a capability's "verification"). */
  readonly groups: ReadonlyArray<{ readonly group: string; readonly members: readonly string[] }>;
}

export interface SelectOptions {
  readonly field?: string;
  readonly group?: string;
  /** Catalogs only: the entry whose records are considered. */
  readonly entityId?: string;
  /** Present for a catalog document; absent for an entity or config/roadmap. */
  readonly catalog?: CatalogSelectScope;
}

export interface Selection {
  /** The record the options named; for a group, that group's record. */
  readonly target: ConflictEntry;
  /** Every record the resolution consumes. A coupled selection is the whole group. */
  readonly selected: ConflictEntry[];
  /** Every other record, in file order. */
  readonly remaining: ConflictEntry[];
}

/** The part of a catalog record's fieldPath below its entry: "/capabilities/3/summary" is "/summary". */
function entryRelativePath(c: ConflictEntry, key: string): string {
  const prefix = new RegExp(`^/${key}/\\d+`).exec(c.fieldPath);
  return prefix ? c.fieldPath.slice(prefix[0].length) : c.fieldPath;
}

/**
 * T-529: the one selection rule `resolve` uses, for entities and catalogs.
 *
 * An entity (and config/roadmap) keeps its exact prior behaviour: the first
 * record matching --field, and when that record belongs to a coupled group,
 * every record of the group. A catalog scopes first: with an entry id, only
 * the records naming that entry; without one, only the document-level records
 * (the version, the order, a whole-document fallback). Inside that scope a
 * --group, or a --field naming a group member, selects the group's record, so
 * two conflicted capabilities never consume each other's group. Invariant
 * records are never selected here: they have their own resolvers.
 */
export function selectConflicts(conflicts: readonly ConflictEntry[], options: SelectOptions): Selection {
  const catalog = options.catalog;
  if (!catalog) {
    const target = conflicts.find((c) => matchesField(c, options.field!));
    if (!target) {
      throw new Error(`No conflict found for field "${options.field}"`);
    }
    const selected = target.kind === "coupled" && target.group
      ? conflicts.filter((c) => c.kind === "coupled" && c.group === target.group)
      : [target];
    return { target, selected, remaining: conflicts.filter((c) => !selected.includes(c)) };
  }

  const where = options.entityId !== undefined ? ` on entry "${options.entityId}"` : " at the document level";
  const scope = conflicts.filter((c) =>
    c.kind !== "invariant" &&
    (options.entityId !== undefined ? c.entityId === options.entityId : c.entityId === undefined));
  let selected: ConflictEntry[];
  if (options.group !== undefined) {
    selected = scope.filter((c) => c.kind === "coupled" && c.group === options.group);
    if (selected.length === 0) throw new Error(`No "${options.group}" group conflict found${where}`);
  } else if (options.field !== undefined) {
    const plain = options.field.replace(/^\//, "");
    const head = plain.split("/")[0]!;
    const group = catalog.groups.find((g) => g.members.includes(head));
    const groupRecord = group
      ? scope.find((c) => c.kind === "coupled" && c.group === group.group)
      : undefined;
    if (groupRecord) {
      selected = [groupRecord];
    } else {
      const target = scope.find((c) =>
        c.entityId !== undefined ? entryRelativePath(c, catalog.key) === `/${plain}` : matchesField(c, options.field!));
      if (!target) throw new Error(`No conflict found for field "${options.field}"${where}`);
      selected = [target];
    }
  } else {
    selected = scope;
    if (selected.length === 0) throw new Error(`No conflict found${where}`);
  }
  return { target: selected[0]!, selected, remaining: conflicts.filter((c) => !selected.includes(c)) };
}

function isDeletedSnapshot(obj: Record<string, unknown>): boolean {
  return obj.lifecycle === "deleted" || (obj.deletedAt != null && obj.deletedAt !== undefined);
}

function otherSide(side: "ours" | "theirs" | undefined): "ours" | "theirs" {
  return side === "ours" ? "theirs" : "ours";
}

/**
 * Wholesale replacement of the entity body with a full-entity object. The
 * append-only fields (receipts, landings, the resolution history) are never
 * replaced: the body keeps every element it held, in order, followed by any
 * element only the chosen side holds, compared by canonical content. Open
 * receipt conflicts keep naming exactly the bodies they named.
 */
function replaceEntityBody(entity: Record<string, unknown>, chosen: Record<string, unknown>): void {
  // A present value that is not an array is never read as absent: identical on
  // both sides it is kept as it is, otherwise nothing is touched.
  const kept = new Map<string, unknown>();
  for (const field of APPEND_ONLY_FIELDS) {
    const cur = entity[field];
    const inc = chosen[field];
    const bad = (v: unknown) => v !== undefined && !Array.isArray(v);
    if (bad(cur) || bad(inc)) {
      if (cur !== undefined && inc !== undefined && canonicalJson(cur) === canonicalJson(inc)) {
        kept.set(field, cur);
        continue;
      }
      throw new Error(
        `Cannot replace the whole record: ${field} is not an array on ${bad(cur) ? "the record" : "the chosen side"}. ` +
        `Repair ${field} by hand into an array holding every element, then resolve again; nothing was written.`,
      );
    }
  }
  for (const field of APPEND_ONLY_FIELDS) {
    if (kept.has(field)) continue;
    const current = Array.isArray(entity[field]) ? (entity[field] as unknown[]) : undefined;
    const incoming = Array.isArray(chosen[field]) ? (chosen[field] as unknown[]) : [];
    if (current === undefined && chosen[field] === undefined) continue;
    const out = [...(current ?? [])];
    const seen = new Set(out.map((e) => canonicalJson(e)));
    for (const e of incoming) {
      const text = canonicalJson(e);
      if (!seen.has(text)) {
        seen.add(text);
        out.push(e);
      }
    }
    kept.set(field, out);
  }
  for (const k of Object.keys(entity)) {
    if (k !== "_conflicts") delete entity[k];
  }
  for (const [k, v] of Object.entries(chosen)) {
    if (k !== "_conflicts" && !isReservedKey(k)) entity[k] = v;
  }
  for (const [field, value] of kept) entity[field] = value;
}

/**
 * Applies one entity-level entry. Returns a human-readable message describing
 * what happened. Throws (leaving the entity body untouched by this entry) when
 * the chosen content is unrecoverable.
 */
function applyEntityLevel(
  entity: Record<string, unknown>,
  c: ConflictEntry,
  options: ResolveOptions,
  warnings: string[],
): string {
  if (options.value !== undefined) {
    const value = options.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `Entity-level conflicts take a full entity object via --value '<full entity JSON>'.`,
      );
    }
    const chosen = value as Record<string, unknown>;
    if (chosen.id !== undefined && entity.id !== undefined && chosen.id !== entity.id) {
      throw new Error(
        `--value id "${String(chosen.id)}" does not match entity id "${String(entity.id)}".`,
      );
    }
    replaceEntityBody(entity, chosen);
    return "Applied custom entity value.";
  }

  const side = options.use!;
  const chosen = side === "ours" ? c.ours : c.theirs;

  // Legacy placeholder entries written by storybloq < 1.5.0 record only
  // "deleted"/"edited" strings -- the actual content was never captured.
  if (typeof chosen === "string") {
    if (chosen === "deleted") {
      entity.lifecycle = "deleted";
      if (entity.deletedAt == null) entity.deletedAt = new Date().toISOString();
      entity.deletedBy = options.actor ?? "unknown";
      warnings.push(
        `Attribution on the synthesized tombstone is best-effort: the original delete stamp was never recorded by the pre-1.5.0 driver.`,
      );
      return `Applied delete (tombstone) from ${side}.`;
    }
    throw new Error(
      `This delete-edit conflict was recorded by storybloq < 1.5.0 and does not contain the edited content. ` +
      `Recover it with: git log --all -p -- .story/<dir>/<id>.json, then apply it with: ` +
      `storybloq resolve <id> --value '<full entity JSON>' -- or choose the delete side with --use ${otherSide(side)}.`,
    );
  }

  // R3: a side with no recoverable content must fail loudly, never write
  // null/undefined/{} into the entity body.
  if (
    chosen === null || chosen === undefined ||
    (typeof chosen === "object" && !Array.isArray(chosen) && Object.keys(chosen as Record<string, unknown>).length === 0)
  ) {
    throw new Error(
      `Side "${side}" of this conflict has no recoverable content; use --use ${otherSide(side)} ` +
      `or resolve by hand with --value '<full entity JSON>'.`,
    );
  }
  if (typeof chosen !== "object" || Array.isArray(chosen)) {
    throw new Error(
      `Side "${side}" of this conflict is not an entity snapshot; resolve with --value '<full entity JSON>'.`,
    );
  }

  const snapshot = chosen as Record<string, unknown>;
  if (snapshot.id !== undefined && entity.id !== undefined && snapshot.id !== entity.id) {
    throw new Error(
      `Snapshot id "${String(snapshot.id)}" does not match entity id "${String(entity.id)}".`,
    );
  }
  replaceEntityBody(entity, snapshot);
  return isDeletedSnapshot(snapshot)
    ? `Applied delete (tombstone) from ${side}.`
    : `Restored edited entity from ${side}.`;
}

/**
 * T-522: a side that never HAD the member (its recorded value is undefined)
 * must leave no key behind. Assigning `undefined` keeps an own property that
 * `Object.hasOwn`, `in` and a later structural merge all see; only a JSON
 * round-trip would have hidden it.
 */
function applySide(entity: Record<string, unknown>, name: string, value: unknown): void {
  if (value === undefined) delete entity[name];
  else entity[name] = value;
}

export function resolveConflicts(
  entity: Record<string, unknown>,
  options: ResolveOptions,
): ResolveResult {
  const conflicts = entity._conflicts as ConflictEntry[] | undefined;
  if (!conflicts || conflicts.length === 0) {
    return { resolved: [], remaining: 0, fullyResolved: true, warnings: [], messages: [] };
  }

  const resolved: string[] = [];
  const remaining: ConflictEntry[] = [];
  const warnings: string[] = [];
  const messages: string[] = [];

  if (options.field) {
    const selection = selectConflicts(conflicts, { field: options.field });
    const target = selection.target;
    if (isReceiptKind(target)) {
      throw new Error(`--field "${options.field}" names a receipt conflict. ${RECEIPT_RESOLVE_HINT}`);
    }
    if (isAppendOnlyConflict(target)) {
      throw new Error(`--field "${options.field}" names the append-only field ${fieldName(target)}, which is never replaced or deleted. ${RECEIPT_RESOLVE_HINT}`);
    }

    if (target.kind === "coupled" && target.group) {
      if (options.value !== undefined) {
        throw new Error(`Cannot use --value on coupled group field "${options.field}". Use --use ours|theirs to resolve coupled groups.`);
      }
      const side = options.use;
      if (!side) {
        throw new Error(`Coupled group field "${options.field}" requires --use ours|theirs.`);
      }
      for (const c of selection.selected) {
        const name = fieldName(c);
        // ISS-801: reserved names are never legitimate top-level fields;
        // skip the write, still consume the conflict.
        if (!isReservedKey(name)) applySide(entity, name, side === "ours" ? c.ours : c.theirs);
        resolved.push(name);
      }
      remaining.push(...selection.remaining);
    } else {
      // ISS-758: without an explicit choice the old code silently applied
      // theirs. Require the user to pick a side or supply a value.
      if (options.value === undefined && !options.use) {
        throw new Error(
          `--field "${options.field}" requires --use ours|theirs or --value. ` +
          `Example: storybloq resolve <id> --field ${options.field} --use theirs`,
        );
      }
      if (isEntityLevel(target)) {
        messages.push(applyEntityLevel(entity, target, options, warnings));
        resolved.push("_entity");
      } else {
        const name = fieldName(target);
        const value = options.value !== undefined
          ? options.value
          : options.use === "ours" ? target.ours : target.theirs;
        if (!isReservedKey(name)) entity[name] = value;
        resolved.push(name);
      }
      remaining.push(...selection.remaining);
    }
  } else if (options.use) {
    const side = options.use;
    // Entity-level entries are applied FIRST (wholesale body replacement),
    // then field-level entries land on the replaced body.
    const receiptLevel = conflicts.filter((c) => isAppendOnlyConflict(c));
    const entityLevel = conflicts.filter((c) => !isAppendOnlyConflict(c) && isEntityLevel(c));
    const fieldLevel = conflicts.filter((c) => !isAppendOnlyConflict(c) && !isEntityLevel(c));
    if (receiptLevel.length > 0) {
      remaining.push(...receiptLevel);
      messages.push(`${receiptLevel.length} receipt conflict(s) left open. ${RECEIPT_RESOLVE_HINT}`);
    }
    for (const c of entityLevel) {
      // Blanket application always uses the side; --value only applies to a
      // --field-targeted entry.
      messages.push(applyEntityLevel(entity, c, { use: side, actor: options.actor }, warnings));
      resolved.push("_entity");
    }
    for (const c of fieldLevel) {
      const name = fieldName(c);
      if (!isReservedKey(name)) applySide(entity, name, side === "ours" ? c.ours : c.theirs);
      resolved.push(name);
    }
  } else {
    throw new Error("Must specify --use or --field");
  }

  if (remaining.length === 0) {
    delete entity._conflicts;
  } else {
    entity._conflicts = remaining;
  }

  return {
    resolved,
    remaining: remaining.length,
    fullyResolved: remaining.length === 0,
    warnings,
    messages,
  };
}
