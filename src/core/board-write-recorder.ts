import { AsyncLocalStorage } from "node:async_hooks";
import { sep } from "node:path";

/**
 * ISS-1107: the board files one write call actually published or removed.
 *
 * A board write tool (MCP) or command (CLI) runs its handler inside a
 * context; the project-loader choke points record each logical target after
 * the operation succeeded. The reply then reads each recorded path's git
 * state, so the path is the file written, never one derived from a display id
 * (hash filenames and legacy display-id filenames both come out exact).
 *
 * Only logical targets are recorded: temp files, the transaction journal and
 * recovery never reach `recordBoardTarget`. With no context active the call is
 * a no-op, so every other caller is unaffected.
 */

export type BoardTargetKind = "write" | "delete";

export interface BoardWriteContext {
  /** The tool or command name, used for the commit verb. */
  readonly tool: string;
  /** Whether the caller asked for a path-scoped commit. */
  readonly commit: boolean;
  /** Absolute path to final kind, in first-recorded order. */
  readonly targets: Map<string, BoardTargetKind>;
  /**
   * T-538: targets outside `.story/` that a commit must include for the write
   * to be whole (a checkpoint's copied evidence file). Absent means none.
   */
  readonly required?: Set<string>;
}

const boardWriteContext = new AsyncLocalStorage<BoardWriteContext>();

/** Runs `fn` with a fresh recorder; the returned context holds what it wrote. */
export async function runWithBoardWriteContext<T>(
  tool: string,
  commit: boolean,
  fn: () => Promise<T>,
): Promise<{ value: T; context: BoardWriteContext }> {
  const context: BoardWriteContext = { tool, commit, targets: new Map(), required: new Set() };
  const value = await boardWriteContext.run(context, fn);
  return { value, context };
}

/** The recorder for the current call, if any. */
export function activeBoardWriteContext(): BoardWriteContext | undefined {
  return boardWriteContext.getStore();
}

/** True for a path inside a `.story/` directory. */
export function isBoardPath(absPath: string): boolean {
  return absPath.includes(`${sep}.story${sep}`);
}

/**
 * Records one logical board target. Final-operation semantics: one entry per
 * path, and the last kind wins (a write then a delete reads as a delete).
 */
export function recordBoardTarget(absPath: string, kind: BoardTargetKind): void {
  const context = boardWriteContext.getStore();
  if (!context || !isBoardPath(absPath)) return;
  context.targets.set(absPath, kind);
}

/**
 * T-538: records a file outside `.story/` that this write made part of the
 * board's state, so `--commit` commits it with the ledger file that names it
 * and reports the commit incomplete if it could not.
 */
export function recordRequiredCommitTarget(absPath: string): void {
  const context = boardWriteContext.getStore();
  if (!context) return;
  context.targets.set(absPath, "write");
  context.required?.add(absPath);
}
