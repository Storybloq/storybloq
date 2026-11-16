/**
 * C-v4.1 commit 3: `storybloq receipt add` and `storybloq receipts <id>`.
 *
 * `handleReceiptAdd` is the one handler both the CLI and `storybloq_receipt_add`
 * call, so both store the same record; the CLI only maps its flags onto the
 * MCP input shape first.
 */
import { addReceipt } from "../../core/receipt-add.js";
import { formatReceiptEntry, receiptsPage, RECEIPTS_PAGE_SIZE } from "../../core/receipts-page.js";
import { ExitCode } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

type Format = "md" | "json";

function fail(format: Format, message: string): CommandResult {
  return {
    output: format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message,
    exitCode: ExitCode.USER_ERROR,
  };
}

/** The shared add handler: input in the MCP shape, rendered for either client. */
export async function handleReceiptAdd(root: string, input: Record<string, unknown>, format: Format): Promise<CommandResult> {
  let receipt: Record<string, unknown>;
  try {
    receipt = await addReceipt(root, input);
  } catch (e) {
    return fail(format, e instanceof Error ? e.message : String(e));
  }
  const message = `Receipt ${String(receipt.id)} (${String(receipt.kind)}, ${String(receipt.result)}) added to ${String(receipt.target)}.`;
  if (format === "json") return { output: JSON.stringify({ ok: true, data: { message, receipt } }, null, 2) };
  return { output: message };
}

/** CLI flags to the MCP input shape, then the shared handler. */
export async function handleReceiptAddCommand(
  root: string, target: string, flags: Record<string, unknown>, format: Format,
): Promise<CommandResult> {
  const input: Record<string, unknown> = { target };
  for (const k of ["kind", "sha", "result", "base", "command", "evidence", "repo"] as const) {
    if (flags[k] !== undefined) input[k] = flags[k];
  }
  if (flags.unit !== undefined) input.unitRef = flags.unit;
  for (const k of ["covers", "supersedes"] as const) {
    if (flags[k] !== undefined) input[k] = Array.isArray(flags[k]) ? flags[k] : [flags[k]];
  }
  if (flags.data !== undefined) {
    try {
      input.data = typeof flags.data === "string" ? JSON.parse(flags.data) : flags.data;
    } catch {
      return fail(format, "invalid_receipt: data: --data is not valid JSON. Nothing was written.");
    }
  }
  const clean = flags.builtClean === true;
  const dirty = flags.builtDirty === true;
  if (clean && dirty) return fail(format, "invalid_receipt: attestation: pass --built-clean or --built-dirty, not both. Nothing was written.");
  if (flags.builtFrom !== undefined || clean || dirty) {
    if (flags.builtFrom === undefined || (!clean && !dirty)) {
      return fail(format, "invalid_receipt: attestation: --built-from needs --built-clean or --built-dirty, and they need --built-from. Nothing was written.");
    }
    input.attestation = { builtFromSha: flags.builtFrom, builtClean: clean };
  }
  return handleReceiptAdd(root, input, format);
}

/** `storybloq receipts <id> [--page n]`: one page of a ticket's or issue's receipts. */
export function handleReceiptsCommand(id: string, page: number | undefined, ctx: CommandContext): CommandResult {
  const ticket = ctx.state.resolveTicketRef(id);
  const issue = ticket.kind === "found" ? undefined : ctx.state.resolveIssueRef(id);
  const hit = ticket.kind === "found" ? ticket.item : issue?.kind === "found" ? issue.item : undefined;
  if (!hit) return { output: fail(ctx.format as Format, `${id} is not a ticket or issue on this board.`).output, exitCode: ExitCode.USER_ERROR, errorCode: "not_found" };
  const view = receiptsPage(hit as unknown as Record<string, unknown>, page ?? 1);
  if (!view.ok) return fail(ctx.format as Format, view.message);
  if (ctx.format === "json") return { output: JSON.stringify({ ok: true, data: view.page }, null, 2) };
  const p = view.page;
  const lines = [`Receipts on ${id}: ${p.summary.total} (page ${p.page} of ${p.totalPages}, ${RECEIPTS_PAGE_SIZE} per page)`];
  for (const e of p.entries) lines.push(`- ${formatReceiptEntry(e)}`);
  return { output: lines.join("\n") };
}
