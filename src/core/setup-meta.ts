/**
 * T-538 S2: the `setup` field that ties a ledger item to one setup (plan v5
 * 1e). It is a passthrough field on tickets, issues and notes, so a client
 * that does not know it keeps it byte for byte.
 *
 * - A ticket (checkpoints included) or an issue carries an item key:
 *   `{setupId, key}`, with `key` K1 to K9999 in one namespace across phases,
 *   tickets and issues. An item that gave its key up to another (a merge
 *   duplicate the owner resolved) carries `supersededBy` and no longer owns it.
 * - A note carries an internal record instead: `{setupId, record}`, where
 *   `record` is `progress` (the progress note) or `final` (the setup note).
 *   The handover is a record too, but it is a file, found by its slug.
 *
 * A note with a key, or a ticket or issue with a record, is refused.
 */
import { z } from "zod";
import { SETUP_ID_PATTERN } from "./setup-review.js";

export const SETUP_KEY_PATTERN = /^K[1-9][0-9]{0,3}$/;
export const SETUP_RECORDS = ["progress", "final", "handover"] as const;
export type SetupRecord = (typeof SETUP_RECORDS)[number];
/** The records a note can carry; the handover is a file, not a note. */
export const NOTE_SETUP_RECORDS = ["progress", "final"] as const;

const setupId = z.string().regex(SETUP_ID_PATTERN, "is not a setup id (SS-<8 hex>)");
const key = z.string().regex(SETUP_KEY_PATTERN, "is not an item key (K1 to K9999)");

export const SetupItemMetaSchema = z.object({
  setupId,
  key,
  supersededBy: z.string().min(1).optional(),
}).strict();
export type SetupItemMeta = z.infer<typeof SetupItemMetaSchema>;

export const SetupRecordMetaSchema = z.object({
  setupId,
  record: z.enum(NOTE_SETUP_RECORDS),
}).strict();
export type SetupRecordMeta = z.infer<typeof SetupRecordMetaSchema>;

export type SetupEntity = "ticket" | "issue" | "note";

export type ParsedSetupMeta =
  | { readonly kind: "none" }
  | { readonly kind: "item"; readonly meta: SetupItemMeta }
  | { readonly kind: "record"; readonly meta: SetupRecordMeta }
  | { readonly kind: "invalid"; readonly reason: string };

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "is not valid";
  const at = issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
  return `${at}${issue.message}`;
}

/** Reads an entity's `setup` field; `none` when the field is absent. */
export function parseSetupMeta(entity: SetupEntity, item: object): ParsedSetupMeta {
  if (!Object.hasOwn(item, "setup")) return { kind: "none" };
  const raw = (item as { setup?: unknown }).setup;
  const isObject = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  if (entity === "note") {
    if (isObject && Object.hasOwn(raw, "key")) return { kind: "invalid", reason: "a note carries a setup record, never an item key" };
    const parsed = SetupRecordMetaSchema.safeParse(raw);
    return parsed.success ? { kind: "record", meta: parsed.data } : { kind: "invalid", reason: firstIssue(parsed.error) };
  }
  if (isObject && Object.hasOwn(raw, "record")) return { kind: "invalid", reason: `a ${entity} carries an item key, never a setup record` };
  const parsed = SetupItemMetaSchema.safeParse(raw);
  return parsed.success ? { kind: "item", meta: parsed.data } : { kind: "invalid", reason: firstIssue(parsed.error) };
}
