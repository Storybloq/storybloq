import { randomBytes } from "node:crypto";
import { encodeBase32Crockford } from "./canonical-id.js";
import { ProjectLoaderError } from "./errors.js";
import { withProjectLockForReceipt, writeIssueUnlocked, writeTicketUnlocked } from "./project-loader.js";
import { RECEIPT_APPEND_AUTHORITY } from "./receipts-guard.js";
import { ReceiptSchema, receiptElementId } from "./receipts.js";

/**
 * C-v4.1 3.4 (append path): the one writer that adds a receipt. It takes the
 * project lock, reloads the record from disk, mints the id against the ids
 * already there, appends, and writes through preparation and byte
 * authorisation under `RECEIPT_APPEND_AUTHORITY`. `receipt add` (commit 3)
 * builds the body and checks `supersedes` (7) on top of this.
 *
 * A present `receipts` value that is not an array is refused, never read as
 * empty. An id that is already on the record is regenerated up to three
 * times, then refused with `id_collision`.
 */

export const RECEIPT_ID_RETRIES = 3;

export function mintReceiptId(): string {
  return `rc-${encodeBase32Crockford(randomBytes(10))}`;
}

export interface ReceiptAppendTarget {
  readonly kind: "ticket" | "issue";
  readonly id: string;
}

export interface ReceiptAppendDeps {
  /** Test seam: the id source. */
  readonly mintId?: () => string;
}

export async function appendReceipt(
  root: string,
  target: ReceiptAppendTarget,
  build: (id: string) => Record<string, unknown>,
  deps: ReceiptAppendDeps = {},
): Promise<Record<string, unknown>> {
  const mint = deps.mintId ?? mintReceiptId;
  let appended: Record<string, unknown> | undefined;
  await withProjectLockForReceipt(root, async ({ state }) => {
    const existing = target.kind === "ticket" ? state.ticketByID(target.id) : state.issueByID(target.id);
    if (!existing) throw new ProjectLoaderError("not_found", `${target.kind} ${target.id} not found`);
    const record = existing as unknown as Record<string, unknown>;
    const has = Object.prototype.hasOwnProperty.call(record, "receipts");
    const prior = has ? record.receipts : undefined;
    if (prior !== undefined && !Array.isArray(prior)) {
      throw new ProjectLoaderError("conflict", `receipts_malformed: ${target.id} has a receipts value that is not an array; repair it by hand into an array before adding a receipt. Nothing was written.`);
    }
    const taken = new Set((prior ?? []).map(receiptElementId).filter((x): x is string => x !== undefined));
    let id = mint();
    for (let retry = 0; taken.has(id); retry++) {
      if (retry >= RECEIPT_ID_RETRIES) {
        throw new ProjectLoaderError("conflict", `id_collision: ${RECEIPT_ID_RETRIES + 1} minted receipt ids were already on ${target.id}; nothing was written.`);
      }
      id = mint();
    }
    const body = build(id);
    if (body.id !== id || !ReceiptSchema.safeParse(body).success) {
      throw new ProjectLoaderError("invalid_input", `The receipt for ${target.id} is not a well-formed v 1 receipt with the minted id; nothing was written.`);
    }
    const next = { ...record, receipts: [...(prior ?? []), body] };
    if (target.kind === "ticket") await writeTicketUnlocked(next as never, root, { receiptsAuthority: RECEIPT_APPEND_AUTHORITY });
    else await writeIssueUnlocked(next as never, root, { receiptsAuthority: RECEIPT_APPEND_AUTHORITY });
    appended = body;
  });
  return appended!;
}
