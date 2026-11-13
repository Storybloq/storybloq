/**
 * C-v4.1 2.1 and 2.3 (ISS-1433): `storybloq board-id init` and `storybloq board-id adopt`.
 *
 * Both write config.json through the canonical config writer under the project
 * lock, then commit only that file (the ISS-1107 recorder with commit forced on).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOARD_ID_AUTHORITY, isBoardId, mintBoardId, readLandedBoardId, receiptsNamingBoard,
} from "../../core/board-id.js";
import { runWithBoardWriteContext } from "../../core/board-write-recorder.js";
import { reportBoardWrite, type BoardWriteReport } from "../../core/board-git-state.js";
import type { CommandResult } from "../types.js";

type Format = "md" | "json";

function render(format: Format, ok: boolean, message: string, data: Record<string, unknown> = {}, report?: BoardWriteReport): CommandResult {
  const lines = report?.lines ?? [];
  if (format === "json") {
    const body = ok
      ? { ok: true, data: { message, ...data, ...(report?.gitCommit ? { gitCommit: report.gitCommit } : {}) } }
      : { ok: false, error: message };
    return ok ? { output: JSON.stringify(body, null, 2) } : { output: JSON.stringify(body, null, 2), exitCode: 1 };
  }
  const output = [message, ...lines].join("\n");
  return ok ? { output } : { output, exitCode: 1 };
}

function readConfigRaw(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
}

/** Mints the board id on a board that has none and commits only config.json. */
export async function handleBoardIdInit(root: string, format: Format): Promise<CommandResult> {
  const { writeConfig } = await import("../../core/project-loader.js");
  let refused: string | undefined;
  let minted: string | undefined;
  const { context } = await runWithBoardWriteContext("board-id init", true, async () => {
    const config = readConfigRaw(root);
    if (isBoardId(config.boardId)) {
      refused = `This board already has the board id ${config.boardId}. It never changes; nothing was written.`;
      return;
    }
    minted = mintBoardId();
    await writeConfig({ ...config, boardId: minted } as never, root);
  });
  if (refused) return render(format, false, refused);
  const report = await reportBoardWrite(context);
  return render(format, true, `Board id ${minted} written to .story/config.json. Land it before recording receipts.`, { boardId: minted }, report);
}

/**
 * Replaces this clone's board id with the one on `ref` (the default branch)
 * and clears any board-identity conflict. Refuses while any receipt on this
 * board names the local id.
 */
export async function handleBoardIdAdopt(root: string, opts: { ref?: string }, format: Format): Promise<CommandResult> {
  const ref = opts.ref ?? "origin/main";
  const { withConflictResolutionLock, writeConfigUnlocked } = await import("../../core/project-loader.js");
  let refused: string | undefined;
  let message = "";
  let landed: string | undefined;
  const { context } = await runWithBoardWriteContext("board-id adopt", true, async () => {
    await withConflictResolutionLock(root, async ({ state }) => {
      landed = readLandedBoardId(root, ref);
      if (!landed) {
        refused = `No board id on ${ref}. Land one first (\`storybloq board-id init\` on the default branch).`;
        return;
      }
      const config = readConfigRaw(root);
      const local = isBoardId(config.boardId) ? config.boardId : undefined;
      const conflicts = Array.isArray(config._conflicts) ? (config._conflicts as Record<string, unknown>[]) : [];
      const kept = conflicts.filter((c) => c?.kind !== "board-identity");
      if (local === landed && kept.length === conflicts.length) {
        message = `This board already carries the landed board id ${landed}; nothing was written.`;
        return;
      }
      if (local && local !== landed) {
        const records = [...state.tickets, ...state.issues] as unknown as Record<string, unknown>[];
        const naming = receiptsNamingBoard(records, local);
        if (naming.length > 0) {
          refused = `Cannot adopt ${landed}: ${naming.length} receipt(s) on this board name the local id ${local}: ${naming.join(", ")}.`;
          return;
        }
      }
      const next: Record<string, unknown> = { ...config, boardId: landed };
      if (kept.length > 0) next._conflicts = kept;
      else delete next._conflicts;
      await writeConfigUnlocked(next as never, root, { boardIdAuthority: BOARD_ID_AUTHORITY });
      message = `Adopted the landed board id ${landed}${local && local !== landed ? ` in place of ${local}` : ""}.`;
    });
  });
  if (refused) return render(format, false, refused);
  const report = await reportBoardWrite(context);
  return render(format, true, message, { boardId: landed }, report);
}
