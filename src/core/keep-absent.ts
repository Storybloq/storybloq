/**
 * ISS-1397: `--keep-absent <field>` on `ticket update` and `issue update`.
 *
 * The Mac app edits a ticket or issue by sending every field it holds. A field
 * the CLI schema leaves optional (a ticket's parentTicket, an issue's order or
 * phase) and the stored file never had reads in the app as null, or 0 for
 * order, and comes back as that value. With this option the update leaves
 * such a key absent: the field is dropped when the stored record has no such
 * key and the value passed is the one the app reads an absent key as. A
 * present key, and any other value, is written as before.
 *
 * The decision is made inside the project lock, on the record the update
 * replaces, so no writer can add or remove the key between the check and the
 * write. Without the option a passed value is saved exactly as before.
 */

export const KEEP_ABSENT_TICKET_FIELDS = ["parentTicket"] as const;
export const KEEP_ABSENT_ISSUE_FIELDS = ["order", "phase"] as const;

export type KeepAbsentField =
  | (typeof KEEP_ABSENT_TICKET_FIELDS)[number]
  | (typeof KEEP_ABSENT_ISSUE_FIELDS)[number];

export interface KeepAbsentOption {
  readonly keepAbsent?: readonly KeepAbsentField[];
}

/** The value the app reads an absent key as. */
const ABSENT_EQUIVALENT: Readonly<Record<KeepAbsentField, unknown>> = {
  parentTicket: null,
  order: 0,
  phase: null,
};

/**
 * `updates` without each named field whose key `existing` lacks and whose
 * value is that field's absent-equivalent. Every other field is kept as given.
 */
export function applyKeepAbsent<U extends object>(
  existing: object,
  updates: U,
  fields: readonly KeepAbsentField[] | undefined,
): U {
  if (!fields || fields.length === 0) return updates;
  const kept = { ...updates } as Record<string, unknown>;
  for (const field of fields) {
    if (Object.hasOwn(existing, field)) continue;
    if (Object.hasOwn(kept, field) && kept[field] === ABSENT_EQUIVALENT[field]) delete kept[field];
  }
  return kept as U;
}
