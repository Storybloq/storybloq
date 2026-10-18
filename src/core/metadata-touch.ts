/**
 * T-481: when a ticket or issue write stamps `updatedDate`.
 *
 * A write stamps only when its content changed. Content is the record seen
 * through `contentProjection`: `updatedDate` itself is not content, and
 * neither are `earmark` and `sweepAcquisition`, which say who holds the item
 * rather than what it is. So an earmark-only write (assign, release, rebind,
 * the pick-time conversion, the sweep's acquisition marker) never stamps,
 * while the same write that also changes a claim or a status does.
 */

type Rec = Record<string, unknown>;

const NOT_CONTENT = new Set(["updatedDate", "earmark", "sweepAcquisition"]);

function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === "object") {
    // Null-prototype, so an own `__proto__` key (JSON.parse makes one) is
    // copied as content instead of being eaten by the prototype setter.
    const out: Rec = Object.create(null) as Rec;
    for (const key of Object.keys(value as Rec).sort()) {
      const member = (value as Rec)[key];
      if (member !== undefined) out[key] = sortedDeep(member);
    }
    return out;
  }
  return value;
}

/**
 * The record's content as a stable string: the loader's one normalisation
 * applied (a null or absent displayId reads as the id, filled and never
 * overwritten), the non-content keys dropped, keys sorted at every depth and
 * undefined members removed.
 */
export function contentProjection(entity: Readonly<Rec>): string {
  const copy: Rec = Object.create(null) as Rec;
  for (const [key, member] of Object.entries(entity)) {
    if (!NOT_CONTENT.has(key)) copy[key] = member;
  }
  if (copy.displayId == null && copy.id !== undefined) copy.displayId = copy.id;
  return JSON.stringify(sortedDeep(copy));
}

/**
 * `next` with `updatedDate` set to `date` when a prior exists and the content
 * differs from it; otherwise `next` as it is. Always a copy; the inputs are
 * never modified. A create (no prior) carries no `updatedDate`: age falls back
 * to the birth date.
 */
export function touchUpdated<T extends object>(next: T, prior: Readonly<Rec> | null | undefined, date: string): T {
  const out = { ...next } as Rec;
  if (prior != null && contentProjection(out) !== contentProjection(prior)) out.updatedDate = date;
  return out as T;
}
