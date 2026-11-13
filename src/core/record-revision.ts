import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { RECEIPT_CONFLICT_KINDS } from "./receipt-resolve.js";

/**
 * C-v4.1 5.2: a record's revision, `canonicalJson` digested with sha256
 * after removing bookkeeping. Everything else is substantive and stays in,
 * any unknown field included (fail closed). Built in commit 3 for the
 * receipt `revisions` field; proof (commit 5) imports it from here.
 */

const BOOKKEEPING = [
  "receipts", "landings",
  // Pen ruling (w15-a6, deviation from the 5.2 list): the resolution history
  // is appended by every `resolve --receipt`, so it is bookkeeping like the
  // receipts it records; otherwise settling a receipt conflict would move the
  // revision and put every existing receipt out of scope.
  "receiptResolutions",
  "updatedAt", "updatedDate", "lastModifiedBy",
  "claim", "claimedBySession", "earmark",
  "rank", "order",
  "displayId", "previousDisplayIds",
] as const;

const COMPLETION: Record<"ticket" | "issue", readonly string[]> = {
  ticket: ["status", "completedDate", "lifecycle", "checkpointEvidence", "resolutionKind"],
  issue: ["status", "resolvedDate", "resolution", "resolutionKind", "lifecycle"],
};

export function recordRevision(record: Readonly<Record<string, unknown>>, kind: "ticket" | "issue"): string {
  const rest: Record<string, unknown> = { ...record };
  for (const field of [...BOOKKEEPING, ...COMPLETION[kind]]) delete rest[field];
  // A top-level key holding undefined is absent once written (serializeJSON
  // drops it), so an in-memory record and its file give one revision.
  for (const key of Object.keys(rest)) if (rest[key] === undefined) delete rest[key];
  if (Array.isArray(rest._conflicts)) {
    const kept = rest._conflicts.filter((c) => !(c !== null && typeof c === "object" && RECEIPT_CONFLICT_KINDS.has(String((c as { kind?: unknown }).kind))));
    if (kept.length === 0) delete rest._conflicts;
    else rest._conflicts = kept;
  }
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}
