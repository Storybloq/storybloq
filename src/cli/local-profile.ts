import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { captureLocalContext } from "../core/local-project-context.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../core/project-lock.js";

const options: Record<string, Record<string, "value" | "boolean">> = {
  reference: {},
  init: { name: "value", type: "value", language: "value", format: "value" },
  "handover latest": { count: "value", brief: "boolean", priming: "boolean", format: "value" },
  recap: { format: "value" },
};

function validateLocalCommand(args: readonly string[]): string {
  const command = args[0] === "handover" ? args.slice(0, 2).join(" ") : args[0];
  if (!command) throw new Error("Choose a task-bound local command.");
  const allowed = Object.hasOwn(options, command) ? options[command] : undefined;
  if (!allowed) throw new Error("This local profile supports reference, init, handover latest and recap. Use the board for project context and edits.");
  for (let i = command === "handover latest" ? 2 : 1; i < args.length; i++) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(args[i] ?? "");
    const name = match?.[1];
    if (!match || !name || !Object.hasOwn(allowed, name)) throw new Error("Unsupported option in the task-bound local command.");
    if (allowed[name] === "value" && match[2] === undefined) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("A local command option is missing its value.");
    } else if (allowed[name] === "boolean" && match[2] !== undefined) {
      throw new Error("Use local boolean options without a value.");
    }
  }
  return command;
}

/** Scoped canonical commands, not a sandbox for the full CLI command surface. */
export async function runLocalProjectCommand(
  args: readonly string[],
  startDir: string,
  dispatch: (root: string, args: readonly string[]) => Promise<void>,
): Promise<void> {
  const command = validateLocalCommand(args);
  const context = captureLocalContext(startDir);
  const root = context.resolve() ?? context.launchDir;
  if (command !== "init") {
    await dispatch(root, args);
    return;
  }
  // Keep admission outside .story: canonical init refuses any existing ledger.
  // Identity-verified lock release/recovery is shared with canonical writers.
  const lock = await acquireProjectLockAsync(join(root, ".storybloq-local-init.lock"));
  try {
    try {
      await lstat(join(root, ".story"));
      throw new Error("This project already has a Storybloq ledger. Local setup cannot overwrite it.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await dispatch(root, args);
  } finally {
    releaseProjectLock(lock);
  }
}
