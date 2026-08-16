import { getMergeRules, getCoupledGroups, type EntityType, type MergeRule } from "./field-classification.js";
import { carryForward, mergeConflictSets, attachConflicts } from "./conflict-lifecycle.js";

export interface ConflictEntry {
  fieldPath: string;
  field?: string;
  kind: "field" | "coupled" | "delete-edit" | "array-element";
  base: unknown;
  ours: unknown;
  theirs: unknown;
  group?: string;
}

function toPointer(fieldName: string): string {
  return `/${fieldName.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

export interface MergeResult {
  merged: Record<string, unknown>;
  conflicts: ConflictEntry[];
  clean: boolean;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const k of keys) {
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

function isDeleted(obj: Record<string, unknown>): boolean {
  return obj.lifecycle === "deleted" || (obj.deletedAt != null && obj.deletedAt !== undefined);
}

function hasNonTombstoneChanges(base: Record<string, unknown>, changed: Record<string, unknown>): boolean {
  const tombstoneFields = new Set(["lifecycle", "deletedAt", "deletedBy"]);
  const allKeys = new Set([...Object.keys(base), ...Object.keys(changed)]);
  for (const k of allKeys) {
    if (tombstoneFields.has(k) || k === "_conflicts") continue;
    if (!deepEqual(base[k], changed[k])) return true;
  }
  return false;
}

function commutativeMerge(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  const baseSet = new Set(base.map((v) => JSON.stringify(v)));
  const oursSet = new Set(ours.map((v) => JSON.stringify(v)));
  const theirsSet = new Set(theirs.map((v) => JSON.stringify(v)));

  const addedByOurs = new Set([...oursSet].filter((v) => !baseSet.has(v)));
  const addedByTheirs = new Set([...theirsSet].filter((v) => !baseSet.has(v)));
  const deletedByOurs = new Set([...baseSet].filter((v) => !oursSet.has(v)));
  const deletedByTheirs = new Set([...baseSet].filter((v) => !theirsSet.has(v)));

  const result = new Set<string>();
  for (const v of baseSet) {
    if (!deletedByOurs.has(v) && !deletedByTheirs.has(v)) result.add(v);
  }
  for (const v of addedByOurs) result.add(v);
  for (const v of addedByTheirs) result.add(v);

  return [...result].sort().map((v) => JSON.parse(v));
}

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Reads the recency value used to pick a coupled-group winner. `spec` is either a top-level
// field name ("updatedAt") or a nested "member.key" path ("claim.since"). Falls back to the
// record's top-level updatedAt then updatedDate so a side with only one of those still has a
// recency signal (e.g. an unclaim whose claim member is now null).
function recencyValue(obj: Record<string, unknown>, spec: string): string {
  let primary: unknown;
  if (spec.includes(".")) {
    const [member, key] = spec.split(".");
    primary = (obj[member!] as Record<string, unknown> | null)?.[key!];
  } else {
    primary = obj[spec];
  }
  return String(primary ?? obj.updatedAt ?? obj.updatedDate ?? "");
}

// ISS-728: ACCEPTED DESIGN LIMITATION -- recency is a pure wall-clock tie-break.
// compareRecency orders ISO timestamps produced by unsynchronized
// `new Date().toISOString()` calls (e.g. claim.since). There is no logical clock
// (no HLC/Lamport/version-vector) anywhere in TS or Swift, so the merge cannot
// detect true concurrency and cannot tell "edited later" from "this machine's
// clock runs fast". This is deliberate (N-059/N-061), and it is LOW risk because
// wall-clock latest-wins decides ONLY two coupled groups: attribution metadata
// (whose onAmbiguous="conflict" already surfaces ties rather than guessing) and
// advisory claims (which by design must never block a merge -- best-effort, flap
// is human-recoverable). Every substantive user-content/state field is
// hard-conflict or coupled-WITHOUT a latestWinsField (see field-classification.ts),
// so concurrent edits there surface as _conflicts and are write-blocked, never
// silently latest-wins-dropped. FUTURE HARDENING (not scheduled): adopt a Hybrid
// Logical Clock (keeps human-readable timestamps) or version vectors only if real
// concurrent claim/attribution collisions are observed, or if a base-less
// real-time transport is added (the CRDT non-goal in N-059). Do NOT reopen
// ISS-673 (its scope was the null-claim-loses-lexically bug; it intentionally
// retained wall-clock comparison).
//
// Compares two recency strings. Returns 1 (a newer), -1 (b newer), or 0 (indistinguishable).
// 0 is returned when the values are equal, both unparseable, or one is date-only and the other
// is a full timestamp on the same calendar day (the time-of-day is genuinely unknown). A
// parseable value beats an unparseable one.
function compareRecency(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  const aDateOnly = DATE_ONLY_REGEX.test(a);
  const bDateOnly = DATE_ONLY_REGEX.test(b);
  if (aDateOnly !== bDateOnly && a.slice(0, 10) === b.slice(0, 10)) return 0;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  const aNaN = Number.isNaN(pa);
  const bNaN = Number.isNaN(pb);
  if (aNaN && bNaN) return 0;
  if (aNaN) return -1;
  if (bNaN) return 1;
  if (pa > pb) return 1;
  if (pa < pb) return -1;
  return 0;
}

export function threeWayMerge(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  entityType: EntityType,
): MergeResult {
  const rules = getMergeRules(entityType);
  const conflicts: ConflictEntry[] = [];
  const merged: Record<string, unknown> = {};

  const carried = carryForward(base, ours, theirs);

  const oursDeleted = !isDeleted(base) && isDeleted(ours);
  const theirsDeleted = !isDeleted(base) && isDeleted(theirs);

  if (oursDeleted && theirsDeleted) {
    Object.assign(merged, ours);
    // ISS-787: both sides tombstoned. If the pre-tombstone BODIES diverged (a
    // teammate edited content THEN deleted, while we only deleted), that edit
    // would be silently lost. Compare ours vs theirs EXCLUDING _conflicts, the
    // tombstone stamps, and every advisory release-group member (claims never
    // block). On divergence, keep ours' tombstone as the body wholesale (advisory
    // fields are excluded from the COMPARISON only, never rewritten) and surface a
    // full-snapshot delete-edit _entity conflict so the edit is recoverable via
    // resolve; otherwise merge clean exactly as before.
    const releaseMembers = getCoupledGroups(entityType)
      .filter((g) => g.onAmbiguous === "release")
      .flatMap((g) => g.members);
    const ignored = new Set<string>(["_conflicts", "lifecycle", "deletedAt", "deletedBy", ...releaseMembers]);
    let bodiesDiverge = false;
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      if (ignored.has(key)) continue;
      if (!deepEqual(ours[key], theirs[key])) { bodiesDiverge = true; break; }
    }
    if (bodiesDiverge) {
      conflicts.push({
        fieldPath: "", field: "_entity", kind: "delete-edit",
        base: entitySnapshot(base),
        ours: entitySnapshot(ours),
        theirs: entitySnapshot(theirs),
      });
    }
    attachConflicts(merged, mergeConflictSets(carried, conflicts));
    return { merged, conflicts, clean: conflicts.length === 0 };
  }

  // ISS-746: delete-vs-edit records FULL entity snapshots (base may be null for
  // the add/add tombstone variant, where base was {}) and keeps the EDITED side
  // as the body: the file stays schema-valid, id-bearing and active, so the
  // loader keeps it, the write gate sees it, and conflicts list/show/resolve
  // find it. The tombstone (with its original audit stamps) lives in the entry.
  if (oursDeleted && !theirsDeleted && hasNonTombstoneChanges(base, theirs)) {
    conflicts.push({
      fieldPath: "", field: "_entity", kind: "delete-edit",
      base: entitySnapshot(base),
      ours: entitySnapshot(ours),
      theirs: entitySnapshot(theirs),
    });
    Object.assign(merged, stripConflicts(theirs));
    attachConflicts(merged, mergeConflictSets(carried, conflicts));
    return { merged, conflicts, clean: false };
  }

  if (theirsDeleted && !oursDeleted && hasNonTombstoneChanges(base, ours)) {
    conflicts.push({
      fieldPath: "", field: "_entity", kind: "delete-edit",
      base: entitySnapshot(base),
      ours: entitySnapshot(ours),
      theirs: entitySnapshot(theirs),
    });
    Object.assign(merged, stripConflicts(ours));
    attachConflicts(merged, mergeConflictSets(carried, conflicts));
    return { merged, conflicts, clean: false };
  }

  const coupledGroups = getCoupledGroups(entityType);
  const handledByCoupled = new Set<string>();

  for (const group of coupledGroups) {
    const baseSnapshot = Object.fromEntries(group.members.map((m) => [m, base[m]]));
    const oursSnapshot = Object.fromEntries(group.members.map((m) => [m, ours[m]]));
    const theirsSnapshot = Object.fromEntries(group.members.map((m) => [m, theirs[m]]));

    const oursChanged = !deepEqual(baseSnapshot, oursSnapshot);
    const theirsChanged = !deepEqual(baseSnapshot, theirsSnapshot);

    if (!oursChanged && !theirsChanged) {
      for (const m of group.members) { merged[m] = base[m]; handledByCoupled.add(m); }
    } else if (!oursChanged) {
      for (const m of group.members) { merged[m] = theirs[m]; handledByCoupled.add(m); }
    } else if (!theirsChanged) {
      for (const m of group.members) { merged[m] = ours[m]; handledByCoupled.add(m); }
    } else if (deepEqual(oursSnapshot, theirsSnapshot)) {
      for (const m of group.members) { merged[m] = ours[m]; handledByCoupled.add(m); }
    } else if (group.latestWinsField) {
      const cmp = compareRecency(
        recencyValue(ours, group.latestWinsField),
        recencyValue(theirs, group.latestWinsField),
      );
      if (cmp !== 0) {
        const winner = cmp > 0 ? ours : theirs;
        for (const m of group.members) { merged[m] = winner[m]; handledByCoupled.add(m); }
      } else if (group.onAmbiguous === "release") {
        // Advisory state (claims): never block a merge. Prefer the side that cleared the
        // group; if neither cleared it, release the group. Release is KEY DELETION, never
        // a null write (ISS-759/ISS-652 doctrine): ClaimSchema is optional-not-nullable, so
        // a claim:null body fails the loader schema and cascades into a blocking _entity
        // conflict (ISS-786). A held member is kept only when a winner side still holds it.
        const oursCleared = group.members.every((m) => ours[m] == null);
        const theirsCleared = group.members.every((m) => theirs[m] == null);
        const winner = oursCleared ? ours : theirsCleared ? theirs : null;
        for (const m of group.members) {
          if (winner && winner[m] != null) {
            merged[m] = winner[m];
          } else {
            delete merged[m];
          }
          handledByCoupled.add(m);
        }
      } else {
        // Audit metadata (attribution): surface the ambiguity rather than resolving arbitrarily.
        for (const m of group.members) {
          // ISS-747/R6: never write undefined into the body when base lacks the
          // member (add/add) -- fall back to ours, then theirs.
          merged[m] = base[m] !== undefined ? base[m] : ours[m] !== undefined ? ours[m] : theirs[m];
          handledByCoupled.add(m);
          conflicts.push({
            fieldPath: toPointer(m),
            field: m,
            kind: "coupled",
            base: base[m],
            ours: ours[m],
            theirs: theirs[m],
            group: group.group,
          });
        }
      }
    } else {
      for (const m of group.members) {
        // ISS-747/R6: same undefined-base fallback as the ambiguous branch.
        merged[m] = base[m] !== undefined ? base[m] : ours[m] !== undefined ? ours[m] : theirs[m];
        handledByCoupled.add(m);
        conflicts.push({
          fieldPath: toPointer(m),
          field: m,
          kind: "coupled",
          base: base[m],
          ours: ours[m],
          theirs: theirs[m],
          group: group.group,
        });
      }
    }
  }

  const allKeys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  allKeys.delete("_conflicts");

  for (const key of allKeys) {
    if (handledByCoupled.has(key)) continue;

    const bVal = base[key];
    const oVal = ours[key];
    const tVal = theirs[key];

    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) {
      merged[key] = bVal;
      continue;
    }
    if (deepEqual(oVal, tVal)) {
      merged[key] = oVal;
      continue;
    }
    if (deepEqual(bVal, oVal)) {
      merged[key] = tVal;
      continue;
    }
    if (deepEqual(bVal, tVal)) {
      merged[key] = oVal;
      continue;
    }

    const rule: MergeRule | undefined = rules[key];

    if (!rule || rule.kind === "hard-conflict") {
      // ISS-747: with base {} (add/add) bVal is undefined and JSON.stringify
      // would silently drop the key, making required fields (title, displayId)
      // vanish from the body. Fall back to ours; the entry still records
      // base: undefined, so nothing is lost.
      merged[key] = bVal !== undefined ? bVal : oVal;
      conflicts.push({ fieldPath: toPointer(key), field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
      continue;
    }

    if (rule.kind === "identity") {
      merged[key] = bVal !== undefined ? bVal : (oVal ?? tVal);
      continue;
    }

    if (rule.kind === "commutative") {
      const bArr = Array.isArray(bVal) ? bVal : [];
      const oArr = Array.isArray(oVal) ? oVal : [];
      const tArr = Array.isArray(tVal) ? tVal : [];
      merged[key] = commutativeMerge(bArr, oArr, tArr);
      continue;
    }

    if (rule.kind === "monotonic") {
      if (typeof oVal === "string" && typeof tVal === "string") {
        merged[key] = oVal >= tVal ? oVal : tVal;
      } else if (typeof oVal === "number" && typeof tVal === "number") {
        merged[key] = Math.max(oVal, tVal);
      } else {
        merged[key] = oVal ?? tVal ?? bVal;
      }
      continue;
    }

    if (rule.kind === "latest-wins") {
      const oObj = (typeof oVal === "object" && oVal !== null) ? oVal as Record<string, unknown> : {};
      const tObj = (typeof tVal === "object" && tVal !== null) ? tVal as Record<string, unknown> : {};
      const oTs = String(oObj[rule.timestampField] ?? "");
      const tTs = String(tObj[rule.timestampField] ?? "");
      if (oTs >= tTs) {
        merged[key] = oVal;
      } else {
        merged[key] = tVal;
      }
      continue;
    }

    merged[key] = bVal !== undefined ? bVal : oVal;
    conflicts.push({ fieldPath: toPointer(key), field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
  }

  // NOTE: `clean` (and therefore the git exit code) reflects only NEW conflicts.
  // A merge that merely carries forward committed-but-unresolved entries exits 0:
  // the merge itself succeeded; failing every later merge of the file would make
  // the state unrecoverable-by-merge. The write-gate re-engages from file content.
  attachConflicts(merged, mergeConflictSets(carried, conflicts));

  return { merged, conflicts, clean: conflicts.length === 0 };
}

export function stripConflicts(obj: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...obj };
  delete copy._conflicts;
  return copy;
}

/**
 * Full-entity snapshot for entity-level conflict entries: the object with its
 * `_conflicts` stripped (snapshots never nest), or null when nothing remains
 * (e.g. an add/add whose base was {}).
 */
export function entitySnapshot(obj: Record<string, unknown>): Record<string, unknown> | null {
  const copy = stripConflicts(obj);
  return Object.keys(copy).length > 0 ? copy : null;
}

function jsonType(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepMergeObjects(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  conflicts: ConflictEntry[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const baseKeys = Object.keys(base);
  const oursOnly = Object.keys(ours).filter((k) => !(k in base));
  const theirsOnly = Object.keys(theirs).filter((k) => !(k in base) && !(k in ours));
  const allKeys = [...baseKeys, ...oursOnly, ...theirsOnly];

  for (const key of allKeys) {
    const pointer = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const bVal = base[key];
    const oVal = ours[key];
    const tVal = theirs[key];
    const bHas = key in base;
    const oHas = key in ours;
    const tHas = key in theirs;

    if (!bHas && oHas && tHas) {
      if (deepEqual(oVal, tVal)) {
        merged[key] = oVal;
      } else {
        merged[key] = oVal;
        conflicts.push({ fieldPath: pointer, field: key, kind: "field", base: undefined, ours: oVal, theirs: tVal });
      }
      continue;
    }

    if (!bHas && oHas && !tHas) { merged[key] = oVal; continue; }
    if (!bHas && !oHas && tHas) { merged[key] = tVal; continue; }

    if (bHas && !oHas && !tHas) { continue; }
    if (bHas && !oHas && tHas) {
      if (deepEqual(bVal, tVal)) { continue; }
      conflicts.push({ fieldPath: pointer, field: key, kind: "delete-edit", base: bVal, ours: undefined, theirs: tVal });
      merged[key] = bVal;
      continue;
    }
    if (bHas && oHas && !tHas) {
      if (deepEqual(bVal, oVal)) { continue; }
      conflicts.push({ fieldPath: pointer, field: key, kind: "delete-edit", base: bVal, ours: oVal, theirs: undefined });
      merged[key] = oVal;
      continue;
    }

    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) { merged[key] = bVal; continue; }
    if (deepEqual(oVal, tVal)) { merged[key] = oVal; continue; }
    if (deepEqual(bVal, oVal)) { merged[key] = tVal; continue; }
    if (deepEqual(bVal, tVal)) { merged[key] = oVal; continue; }

    const bType = jsonType(bVal);
    const oType = jsonType(oVal);
    const tType = jsonType(tVal);

    if (oType !== tType) {
      merged[key] = oVal;
      conflicts.push({ fieldPath: pointer, field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
      continue;
    }

    if (oType === "object" && bType === "object") {
      merged[key] = deepMergeObjects(
        bVal as Record<string, unknown>,
        oVal as Record<string, unknown>,
        tVal as Record<string, unknown>,
        pointer,
        conflicts,
      );
      continue;
    }

    merged[key] = oVal;
    conflicts.push({ fieldPath: pointer, field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
  }

  return merged;
}

function validateKeyedArray(arr: unknown[], keyField: string): void {
  const seen = new Set<string>();
  for (const item of arr) {
    if (typeof item !== "object" || item === null) throw new Error("Array element is not an object");
    const key = (item as Record<string, unknown>)[keyField];
    if (typeof key !== "string" || key === "") throw new Error(`Missing or empty ${keyField} in array element`);
    if (seen.has(key)) throw new Error(`Duplicate ${keyField} "${key}" in array`);
    seen.add(key);
  }
}

function toMap(arr: unknown[], keyField: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of arr) {
    const obj = item as Record<string, unknown>;
    map.set(obj[keyField] as string, obj);
  }
  return map;
}

function orderKeys(arr: unknown[], keyField: string): string[] {
  return arr.map((item) => (item as Record<string, unknown>)[keyField] as string);
}

interface KeyedArrayOpts {
  elementMerge?: boolean;
  blockerMode?: boolean;
}

interface Addition {
  id: string;
  side: 0 | 1; // 0 = ours, 1 = theirs
  source: string[];
}

// Insert added ids into a keyed-array order (ISS-657). Each addition lands
// immediately after its nearest preceding neighbor (from its own side's order)
// that is a STABLE survivor (present in base and on both sides); additions never
// anchor to a one-sided-deleted id, whose survival is not known until the
// emission loop runs. Additions with no stable predecessor go to the front.
// Same-anchor ties resolve ours-before-theirs, then by source order, so chains
// and leading runs keep their authored order. The spine is walked verbatim, so
// one-sided-deleted ids stay exactly where the caller placed them.
function buildMergedOrder(spine: string[], stableSet: Set<string>, additions: Addition[]): string[] {
  const front: Addition[] = [];
  const groups = new Map<string, Addition[]>(); // stable anchor id -> additions placed after it
  for (const add of additions) {
    const srcIdx = add.source.indexOf(add.id);
    let anchorId: string | null = null;
    for (let i = srcIdx - 1; i >= 0; i--) {
      const prev = add.source[i];
      if (prev !== undefined && stableSet.has(prev)) {
        anchorId = prev;
        break;
      }
    }
    if (anchorId === null) {
      front.push(add);
    } else {
      const g = groups.get(anchorId);
      if (g) g.push(add);
      else groups.set(anchorId, [add]);
    }
  }
  const cmp = (a: Addition, b: Addition): number =>
    a.side - b.side || a.source.indexOf(a.id) - b.source.indexOf(b.id);
  front.sort(cmp);
  for (const g of groups.values()) g.sort(cmp);

  const result: string[] = [];
  for (const add of front) result.push(add.id);
  for (const id of spine) {
    result.push(id);
    const g = groups.get(id);
    if (g) for (const add of g) result.push(add.id);
  }
  return result;
}

function keyedArrayMerge(
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  keyField: string,
  parentPointer: string,
  conflicts: ConflictEntry[],
  opts: KeyedArrayOpts = {},
): unknown[] {
  validateKeyedArray(base, keyField);
  validateKeyedArray(ours, keyField);
  validateKeyedArray(theirs, keyField);

  const baseMap = toMap(base, keyField);
  const oursMap = toMap(ours, keyField);
  const theirsMap = toMap(theirs, keyField);

  const baseOrder = orderKeys(base, keyField);
  const oursOrder = orderKeys(ours, keyField);
  const theirsOrder = orderKeys(theirs, keyField);

  const baseIds = new Set(baseOrder);
  const oursIds = new Set(oursOrder);
  const theirsIds = new Set(theirsOrder);

  const oursSharedOrder = oursOrder.filter((id) => baseIds.has(id));
  const theirsSharedOrder = theirsOrder.filter((id) => baseIds.has(id));
  const baseOursOrder = baseOrder.filter((id) => oursIds.has(id));
  const baseTheirsOrder = baseOrder.filter((id) => theirsIds.has(id));

  const oursReordered = !deepEqual(oursSharedOrder, baseOursOrder);
  const theirsReordered = !deepEqual(theirsSharedOrder, baseTheirsOrder);

  // Stable survivors: base ids kept by BOTH sides. These always appear in the
  // output, so they are the only valid anchors for addition placement (ISS-657).
  const stableSet = new Set(baseOrder.filter((id) => oursIds.has(id) && theirsIds.has(id)));

  // Additions, de-duped: an id added by both sides appears once (in ours) and is
  // reconciled by the emission loop, matching the prior behavior.
  const addedByOurs = oursOrder.filter((id) => !baseIds.has(id));
  const addedByTheirs = theirsOrder.filter((id) => !baseIds.has(id) && !oursIds.has(id));
  const additions: Addition[] = [
    ...addedByOurs.map((id) => ({ id, side: 0 as const, source: oursOrder })),
    ...addedByTheirs.map((id) => ({ id, side: 1 as const, source: theirsOrder })),
  ];

  // Visit spine: the base ids to walk, in order. The non-reorder and both-reorder
  // branches keep their exact prior spine (so delete-edit-kept elements stay in
  // base position). The two single-side reorder branches additionally visit base
  // ids the reordering side deleted but the other side still has, so the emission
  // loop applies clean-delete / delete-edit instead of silently dropping them
  // (ISS-658).
  let spine: string[];
  if (oursReordered && theirsReordered && !deepEqual(oursSharedOrder, theirsSharedOrder)) {
    conflicts.push({
      fieldPath: parentPointer,
      field: parentPointer.replace(/^\//, ""),
      kind: "field",
      base: baseOrder,
      ours: oursOrder,
      theirs: theirsOrder,
    });
    spine = [...baseOrder];
  } else if (oursReordered) {
    spine = [...oursSharedOrder];
    for (const id of baseOrder) if (theirsIds.has(id) && !oursIds.has(id)) spine.push(id);
  } else if (theirsReordered) {
    spine = [...theirsSharedOrder];
    for (const id of baseOrder) if (oursIds.has(id) && !theirsIds.has(id)) spine.push(id);
  } else {
    spine = baseOrder.filter((id) => oursIds.has(id) || theirsIds.has(id));
  }

  const mergedOrder = buildMergedOrder(spine, stableSet, additions);

  const removedByOurs = new Set(baseOrder.filter((id) => !oursIds.has(id)));
  const removedByTheirs = new Set(baseOrder.filter((id) => !theirsIds.has(id)));

  const result: unknown[] = [];

  for (const id of mergedOrder) {
    if (removedByOurs.has(id) && removedByTheirs.has(id)) continue;

    if (removedByOurs.has(id)) {
      const theirsEl = theirsMap.get(id)!;
      const baseEl = baseMap.get(id)!;
      if (deepEqual(baseEl, theirsEl)) continue;
      const idx = result.length;
      conflicts.push({
        fieldPath: `${parentPointer}/${idx}`,
        field: `${parentPointer.replace(/^\//, "")}[${keyField}=${id}]`,
        kind: "delete-edit",
        base: baseEl,
        ours: undefined,
        theirs: theirsEl,
      });
      result.push(baseEl);
      continue;
    }

    if (removedByTheirs.has(id)) {
      const oursEl = oursMap.get(id)!;
      const baseEl = baseMap.get(id)!;
      if (deepEqual(baseEl, oursEl)) continue;
      const idx = result.length;
      conflicts.push({
        fieldPath: `${parentPointer}/${idx}`,
        field: `${parentPointer.replace(/^\//, "")}[${keyField}=${id}]`,
        kind: "delete-edit",
        base: baseEl,
        ours: oursEl,
        theirs: undefined,
      });
      result.push(baseEl);
      continue;
    }

    const baseEl = baseMap.get(id);
    const oursEl = oursMap.get(id);
    const theirsEl = theirsMap.get(id);

    if (!baseEl) {
      if (oursEl && theirsEl) {
        if (deepEqual(oursEl, theirsEl)) {
          result.push(oursEl);
        } else {
          const idx = result.length;
          conflicts.push({
            fieldPath: `${parentPointer}/${idx}`,
            field: `${parentPointer.replace(/^\//, "")}[${keyField}=${id}]`,
            kind: "array-element",
            base: undefined,
            ours: oursEl,
            theirs: theirsEl,
          });
          result.push(oursEl);
        }
      } else {
        result.push(oursEl ?? theirsEl);
      }
      continue;
    }

    if (!oursEl || !theirsEl) {
      result.push(oursEl ?? theirsEl ?? baseEl);
      continue;
    }

    if (deepEqual(baseEl, oursEl) && deepEqual(baseEl, theirsEl)) {
      result.push(baseEl);
      continue;
    }
    if (deepEqual(baseEl, oursEl)) { result.push(theirsEl); continue; }
    if (deepEqual(baseEl, theirsEl)) { result.push(oursEl); continue; }
    if (deepEqual(oursEl, theirsEl)) { result.push(oursEl); continue; }

    if (opts.blockerMode) {
      const merged = mergeBlockerElement(baseEl, oursEl, theirsEl, `${parentPointer}/${result.length}`, conflicts);
      result.push(merged);
      continue;
    }

    if (opts.elementMerge) {
      const merged = deepMergeObjects(baseEl, oursEl, theirsEl, `${parentPointer}/${result.length}`, conflicts);
      result.push(merged);
      continue;
    }

    const idx = result.length;
    conflicts.push({
      fieldPath: `${parentPointer}/${idx}`,
      field: `${parentPointer.replace(/^\//, "")}[${keyField}=${id}]`,
      kind: "array-element",
      base: baseEl,
      ours: oursEl,
      theirs: theirsEl,
    });
    result.push(oursEl);
  }

  return result;
}

function mergeBlockerElement(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  conflicts: ConflictEntry[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  const bCleared = base.cleared === true || (base.clearedDate != null);
  const oCleared = ours.cleared === true || (ours.clearedDate != null);
  const tCleared = theirs.cleared === true || (theirs.clearedDate != null);

  merged.cleared = oCleared || tCleared || bCleared;

  const oClearedDate = typeof ours.clearedDate === "string" ? ours.clearedDate : null;
  const tClearedDate = typeof theirs.clearedDate === "string" ? theirs.clearedDate : null;
  if (oClearedDate && tClearedDate) {
    merged.clearedDate = oClearedDate <= tClearedDate ? oClearedDate : tClearedDate;
  } else {
    merged.clearedDate = oClearedDate ?? tClearedDate ?? base.clearedDate ?? null;
  }

  if (base.createdDate !== undefined) merged.createdDate = base.createdDate;

  const specialKeys = new Set(["cleared", "clearedDate", "createdDate", "name"]);
  merged.name = base.name;

  const allKeys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const key of allKeys) {
    if (specialKeys.has(key)) continue;
    const bVal = base[key];
    const oVal = ours[key];
    const tVal = theirs[key];

    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) { merged[key] = bVal; continue; }
    if (deepEqual(oVal, tVal)) { merged[key] = oVal; continue; }
    if (deepEqual(bVal, oVal)) { merged[key] = tVal; continue; }
    if (deepEqual(bVal, tVal)) { merged[key] = oVal; continue; }

    merged[key] = oVal;
    conflicts.push({
      fieldPath: `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
      field: key,
      kind: "field",
      base: bVal,
      ours: oVal,
      theirs: tVal,
    });
  }

  return merged;
}

const CONFIG_DEEP_MERGE_KEYS = new Set(["features", "recipeOverrides", "team", "federation", "statusWriter"]);
const CONFIG_NODES_KEY = "nodes";

export function mergeConfig(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): MergeResult {
  const b = stripConflicts(base);
  const o = stripConflicts(ours);
  const t = stripConflicts(theirs);
  const conflicts: ConflictEntry[] = [];
  const merged: Record<string, unknown> = {};

  const baseKeys = Object.keys(b);
  const oursOnly = Object.keys(o).filter((k) => !(k in b));
  const theirsOnly = Object.keys(t).filter((k) => !(k in b) && !(k in o));
  const allKeys = [...baseKeys, ...oursOnly, ...theirsOnly];

  for (const key of allKeys) {
    const pointer = toPointer(key);
    const bVal = b[key];
    const oVal = o[key];
    const tVal = t[key];
    const bHas = key in b;
    const oHas = key in o;
    const tHas = key in t;

    const isKnownObjectKey = CONFIG_DEEP_MERGE_KEYS.has(key) || key === CONFIG_NODES_KEY;
    if (isKnownObjectKey) {
      for (const [val, label] of [[bVal, "base"], [oVal, "ours"], [tVal, "theirs"]] as const) {
        if (val !== undefined && jsonType(val) !== "object") {
          throw new Error(`Config key "${key}" must be an object (got ${jsonType(val)} in ${label})`);
        }
      }
    }

    if (!bHas && oHas && tHas) {
      if (deepEqual(oVal, tVal)) {
        merged[key] = oVal;
      } else {
        merged[key] = oVal;
        conflicts.push({ fieldPath: pointer, field: key, kind: "field", base: undefined, ours: oVal, theirs: tVal });
      }
      continue;
    }
    if (!bHas && oHas && !tHas) { merged[key] = oVal; continue; }
    if (!bHas && !oHas && tHas) { merged[key] = tVal; continue; }
    if (bHas && !oHas && !tHas) { continue; }
    if (bHas && !oHas && tHas) {
      if (deepEqual(bVal, tVal)) { continue; }
      merged[key] = bVal;
      conflicts.push({ fieldPath: pointer, field: key, kind: "delete-edit", base: bVal, ours: undefined, theirs: tVal });
      continue;
    }
    if (bHas && oHas && !tHas) {
      if (deepEqual(bVal, oVal)) { continue; }
      merged[key] = oVal;
      conflicts.push({ fieldPath: pointer, field: key, kind: "delete-edit", base: bVal, ours: oVal, theirs: undefined });
      continue;
    }

    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) { merged[key] = bVal; continue; }
    if (deepEqual(oVal, tVal)) { merged[key] = oVal; continue; }
    if (deepEqual(bVal, oVal)) { merged[key] = tVal; continue; }
    if (deepEqual(bVal, tVal)) { merged[key] = oVal; continue; }

    const bType = jsonType(bVal);
    const oType = jsonType(oVal);
    const tType = jsonType(tVal);

    if (oType === "object" && tType === "object" && bType === "object") {
      merged[key] = deepMergeObjects(
        bVal as Record<string, unknown>,
        oVal as Record<string, unknown>,
        tVal as Record<string, unknown>,
        pointer,
        conflicts,
      );
      continue;
    }

    merged[key] = oVal;
    conflicts.push({ fieldPath: pointer, field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
  }

  // ISS-750: carry committed-but-unresolved entries forward (computed from the
  // ORIGINAL unstripped inputs) instead of silently dropping them. See the
  // `clean` note in threeWayMerge: carried-only merges still exit 0.
  const carried = carryForward(base, ours, theirs);
  attachConflicts(merged, mergeConflictSets(carried, conflicts));

  return { merged, conflicts, clean: conflicts.length === 0 };
}

export function mergeRoadmap(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): MergeResult {
  const b = stripConflicts(base);
  const o = stripConflicts(ours);
  const t = stripConflicts(theirs);
  const conflicts: ConflictEntry[] = [];
  const merged: Record<string, unknown> = {};

  const scalarKeys = ["title", "date"];
  for (const key of scalarKeys) {
    const bVal = b[key];
    const oVal = o[key];
    const tVal = t[key];
    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) { merged[key] = bVal; continue; }
    if (deepEqual(oVal, tVal)) { merged[key] = oVal; continue; }
    if (deepEqual(bVal, oVal)) { merged[key] = tVal; continue; }
    if (deepEqual(bVal, tVal)) { merged[key] = oVal; continue; }
    merged[key] = oVal;
    conflicts.push({ fieldPath: toPointer(key), field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
  }

  for (const src of [b, o, t]) {
    if (src.phases !== undefined && !Array.isArray(src.phases)) throw new Error("phases must be an array");
    if (src.blockers !== undefined && !Array.isArray(src.blockers)) throw new Error("blockers must be an array");
  }

  const bPhases = Array.isArray(b.phases) ? b.phases : [];
  const oPhases = Array.isArray(o.phases) ? o.phases : [];
  const tPhases = Array.isArray(t.phases) ? t.phases : [];
  merged.phases = keyedArrayMerge(bPhases, oPhases, tPhases, "id", "/phases", conflicts, { elementMerge: true });

  const bBlockers = Array.isArray(b.blockers) ? b.blockers : [];
  const oBlockers = Array.isArray(o.blockers) ? o.blockers : [];
  const tBlockers = Array.isArray(t.blockers) ? t.blockers : [];
  merged.blockers = keyedArrayMerge(bBlockers, oBlockers, tBlockers, "name", "/blockers", conflicts, { blockerMode: true });

  const handledKeys = new Set(["title", "date", "phases", "blockers", "_conflicts"]);
  const extraKeys = new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)].filter((k) => !handledKeys.has(k)));
  for (const key of extraKeys) {
    const bVal = b[key];
    const oVal = o[key];
    const tVal = t[key];
    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) { merged[key] = bVal; continue; }
    if (deepEqual(oVal, tVal)) { merged[key] = oVal; continue; }
    if (deepEqual(bVal, oVal)) { merged[key] = tVal; continue; }
    if (deepEqual(bVal, tVal)) { merged[key] = oVal; continue; }
    merged[key] = oVal;
    conflicts.push({ fieldPath: toPointer(key), field: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
  }

  // ISS-750: carry committed-but-unresolved entries forward (computed from the
  // ORIGINAL unstripped inputs) instead of silently dropping them. See the
  // `clean` note in threeWayMerge: carried-only merges still exit 0.
  const carried = carryForward(base, ours, theirs);
  attachConflicts(merged, mergeConflictSets(carried, conflicts));

  return { merged, conflicts, clean: conflicts.length === 0 };
}
