/**
 * C-v4.1 commit 5: `storybloq proof <ref> [--page n]` and the CLI-only
 * `storybloq proof non-code add|remove|list` (5.4, pen rulings Q1 and Q4).
 *
 * add and remove read, check and write config.json inside one hold of the
 * project lock, through the canonical config writer, with optional --commit
 * (the ISS-1107 recorder). Every change alters the config digest, so a proof
 * read in flight sees it through its fingerprint (5.6).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalRef, readBoardId } from "../../core/board-id.js";
import { reportBoardWrite } from "../../core/board-git-state.js";
import { runWithBoardWriteContext } from "../../core/board-write-recorder.js";
import { proofView } from "../../core/proof-view.js";
import { findItem, type StateWithRefs } from "../../core/receipt-add.js";
import type { CommandResult } from "../types.js";

type Format = "md" | "json";

export const NON_CODE_REASON_BYTES = 200;

function fail(format: Format, message: string): CommandResult {
  return { output: format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message, exitCode: 1 };
}

function readConfigRaw(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
}

type Entry = { ref: string; reason: string };

function entriesOf(config: Record<string, unknown>): Entry[] {
  const items = (config.proof as { nonCodeItems?: unknown } | undefined)?.nonCodeItems;
  return Array.isArray(items) ? (items as Entry[]) : [];
}

function withEntries(config: Record<string, unknown>, entries: Entry[]): Record<string, unknown> {
  const proof = { ...((config.proof as Record<string, unknown> | undefined) ?? {}) };
  if (entries.length > 0) proof.nonCodeItems = entries;
  else delete proof.nonCodeItems;
  const next = { ...config };
  if (Object.keys(proof).length > 0) next.proof = proof;
  else delete next.proof;
  return next;
}

/** A ref on this board (`ID` or `<thisBoardId>:ID`) to its canonical ref; anything else is refused. */
async function canonicalOnThisBoard(root: string, ref: string): Promise<{ ref: string } | { error: string }> {
  const board = readBoardId(root);
  if (board === undefined) return { error: "board_id_missing: this board has no boardId. Run `storybloq board-id init`, land it, then retry." };
  const colon = ref.lastIndexOf(":");
  if (colon > 0 && ref.slice(0, colon) !== board) return { error: `invalid_ref: ${ref} is not on this board (${board}); edit the list on the board that holds it.` };
  const id = colon > 0 ? ref.slice(colon + 1) : ref;
  const { loadProject } = await import("../../core/project-loader.js");
  const { state } = await loadProject(root);
  const found = findItem(state as unknown as StateWithRefs, id);
  if (found === "ambiguous") return { error: `invalid_ref: ${ref} matches more than one record.` };
  if (found === undefined) return { error: `invalid_ref: ${ref} is not a ticket or issue on this board.` };
  if (found.record.deletedAt !== undefined && found.record.deletedAt !== null) return { error: `invalid_ref: ${ref} is deleted.` };
  return { ref: canonicalRef(board, String(found.record.id)) };
}

/** Test seam: runs after the command is invoked and before the project lock is taken. */
export const nonCodeSeams: { beforeLock: () => Promise<void> } = { beforeLock: async () => {} };

/** The ref is resolved and checked inside `edit`, which runs under the project lock on the locked state and config. */
async function editList(root: string, commit: boolean, format: Format, label: string, edit: (entries: Entry[]) => Promise<Entry[] | string>): Promise<CommandResult> {
  const { withProjectLock, writeConfigUnlocked } = await import("../../core/project-loader.js");
  let refused: string | undefined;
  let after: Entry[] = [];
  await nonCodeSeams.beforeLock();
  const { context } = await runWithBoardWriteContext(label, commit, async () => {
    await withProjectLock(root, { strict: false }, async () => {
      const config = readConfigRaw(root);
      const next = await edit(entriesOf(config));
      if (typeof next === "string") { refused = next; return; }
      after = next;
      await writeConfigUnlocked(withEntries(config, next) as never, root);
    });
  });
  if (refused !== undefined) return fail(format, `${refused} Nothing was written.`);
  const report = await reportBoardWrite(context);
  const message = `proof.nonCodeItems now lists ${after.length} item${after.length === 1 ? "" : "s"}.`;
  if (format === "json") return { output: JSON.stringify({ ok: true, data: { message, nonCodeItems: after, ...(report.gitCommit ? { gitCommit: report.gitCommit } : {}) } }, null, 2) };
  return { output: [message, ...report.lines].join("\n") };
}

export async function handleNonCodeAdd(root: string, ref: string, reason: string | undefined, commit: boolean, format: Format): Promise<CommandResult> {
  if (reason === undefined || reason.trim().length === 0) return fail(format, "invalid_reason: --reason is required. Nothing was written.");
  if (Buffer.byteLength(reason, "utf8") > NON_CODE_REASON_BYTES) return fail(format, `invalid_reason: the reason is at most ${NON_CODE_REASON_BYTES} bytes. Nothing was written.`);
  return editList(root, commit, format, "proof non-code add", async (entries) => {
    const c = await canonicalOnThisBoard(root, ref);
    if ("error" in c) return c.error;
    return entries.some((e) => e.ref === c.ref) ? `already_listed: ${c.ref} is already non-code.` : [...entries, { ref: c.ref, reason }];
  });
}

export async function handleNonCodeRemove(root: string, ref: string, commit: boolean, format: Format): Promise<CommandResult> {
  return editList(root, commit, format, "proof non-code remove", async (entries) => {
    const board = readBoardId(root);
    const c = await canonicalOnThisBoard(root, ref);
    // A listed ref whose item is gone can still be removed by its canonical form.
    const target = "ref" in c ? c.ref : board !== undefined && ref.startsWith(`${board}:`) ? ref : undefined;
    if (target === undefined) return "error" in c ? c.error : `invalid_ref: ${ref}`;
    return entries.some((e) => e.ref === target) ? entries.filter((e) => e.ref !== target) : `not_listed: ${target} is not on the non-code list.`;
  });
}

export function handleNonCodeList(root: string, format: Format): CommandResult {
  const entries = entriesOf(readConfigRaw(root));
  if (format === "json") return { output: JSON.stringify({ ok: true, data: { nonCodeItems: entries } }, null, 2) };
  if (entries.length === 0) return { output: "No items are listed as non-code." };
  return { output: entries.map((e) => `- ${e.ref}: ${e.reason}`).join("\n") };
}

export async function handleProofCommand(root: string, ref: string, page: number | undefined, format: Format): Promise<CommandResult> {
  const view = await proofView(root, ref, page ?? 1);
  if (format === "json") return { output: JSON.stringify({ ok: true, data: view.json }, null, 2) };
  return { output: view.lines.join("\n") };
}
