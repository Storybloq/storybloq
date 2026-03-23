import { isBlockerCleared } from "../../core/queries.js";
import {
  withProjectLock,
  writeRoadmapUnlocked,
} from "../../core/project-loader.js";
import type { Roadmap, Blocker } from "../../models/roadmap.js";
import {
  formatBlockerList,
  successEnvelope,
} from "../../core/output-formatter.js";
import {
  todayISO,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// --- Read Handlers ---

export function handleBlockerList(ctx: CommandContext): CommandResult {
  return { output: formatBlockerList(ctx.state.roadmap, ctx.format) };
}

// --- Write Handlers ---

export async function handleBlockerAdd(
  args: { name: string; note?: string },
  format: string,
  root: string,
): Promise<CommandResult> {
  let createdBlocker: Blocker | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const activeConflict = state.roadmap.blockers.find(
      (b) => b.name === args.name && !isBlockerCleared(b),
    );
    if (activeConflict) {
      throw new CliValidationError("conflict", `Active blocker "${args.name}" already exists`);
    }

    const blocker: Blocker = {
      name: args.name,
      cleared: false,
      createdDate: todayISO(),
      clearedDate: null,
      note: args.note ?? null,
    };

    const newBlockers = [...state.roadmap.blockers, blocker];
    const newRoadmap: Roadmap = { ...state.roadmap, blockers: newBlockers };
    await writeRoadmapUnlocked(newRoadmap, root);
    createdBlocker = blocker;
  });

  if (!createdBlocker) throw new Error("Blocker not created");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(createdBlocker), null, 2) };
  }
  return { output: `Added blocker: ${createdBlocker.name}` };
}

export async function handleBlockerClear(
  name: string,
  note: string | undefined,
  format: string,
  root: string,
): Promise<CommandResult> {
  let clearedBlocker: Blocker | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const idx = state.roadmap.blockers.findIndex(
      (b) => b.name === name && !isBlockerCleared(b),
    );
    if (idx < 0) {
      throw new CliValidationError("not_found", `No active blocker named "${name}"`);
    }

    const existing = state.roadmap.blockers[idx]!;
    const updated: Blocker = {
      ...existing,
      cleared: true,
      clearedDate: todayISO(),
      ...(note !== undefined && { note }),
    };

    const newBlockers = [...state.roadmap.blockers];
    newBlockers[idx] = updated;
    const newRoadmap: Roadmap = { ...state.roadmap, blockers: newBlockers };
    await writeRoadmapUnlocked(newRoadmap, root);
    clearedBlocker = updated;
  });

  if (!clearedBlocker) throw new Error("Blocker not cleared");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(clearedBlocker), null, 2) };
  }
  return { output: `Cleared blocker: ${clearedBlocker.name}` };
}
