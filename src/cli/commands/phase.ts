import { join, resolve } from "node:path";
import { currentPhase } from "../../core/queries.js";
import {
  withProjectLock,
  writeRoadmapUnlocked,
  runTransactionUnlocked,
  serializeJSON,
} from "../../core/project-loader.js";
import { TicketSchema } from "../../models/ticket.js";
import { IssueSchema } from "../../models/issue.js";
import { RoadmapSchema } from "../../models/roadmap.js";
import type { Roadmap, Phase } from "../../models/roadmap.js";
import {
  formatPhaseList,
  formatPhaseTickets,
  formatError,
  successEnvelope,
  ExitCode,
} from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// --- Phase ID validation ---

const PHASE_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PHASE_ID_MAX_LENGTH = 40;

function validatePhaseId(id: string): void {
  if (id.length > PHASE_ID_MAX_LENGTH) {
    throw new CliValidationError("invalid_input", `Phase ID "${id}" exceeds ${PHASE_ID_MAX_LENGTH} characters`);
  }
  if (!PHASE_ID_REGEX.test(id)) {
    throw new CliValidationError("invalid_input", `Phase ID "${id}" must be lowercase alphanumeric with hyphens (e.g. "my-phase")`);
  }
}

// --- Read Handlers ---

export function handlePhaseList(ctx: CommandContext): CommandResult {
  return { output: formatPhaseList(ctx.state, ctx.format) };
}

export function handlePhaseCurrent(ctx: CommandContext): CommandResult {
  const phase = currentPhase(ctx.state);
  if (phase) {
    if (ctx.format === "json") {
      return { output: JSON.stringify(successEnvelope(phase), null, 2) };
    }
    const summary = phase.summary ?? phase.description;
    return { output: `${phase.name} (${phase.id}) — ${summary}` };
  }

  // Differentiate: no phases with leaves vs all complete
  const hasLeavesInAnyPhase = ctx.state.roadmap.phases.some(
    (p) => ctx.state.phaseTickets(p.id).length > 0,
  );

  if (!hasLeavesInAnyPhase) {
    if (ctx.format === "json") {
      return {
        output: JSON.stringify(successEnvelope({ current: null, reason: "no_phases" }), null, 2),
        exitCode: ExitCode.USER_ERROR,
      };
    }
    return {
      output: "No phases with tickets defined.",
      exitCode: ExitCode.USER_ERROR,
    };
  }

  // All phases with leaves are complete
  if (ctx.format === "json") {
    return {
      output: JSON.stringify(successEnvelope({ current: null, reason: "all_complete" }), null, 2),
    };
  }
  return { output: "All phases complete." };
}

export function handlePhaseTickets(
  phaseId: string,
  ctx: CommandContext,
): CommandResult {
  // Check phase existence — return not_found for unknown phase
  const phaseExists = ctx.state.roadmap.phases.some((p) => p.id === phaseId);
  if (!phaseExists) {
    return {
      output: formatError("not_found", `Phase "${phaseId}" not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatPhaseTickets(phaseId, ctx.state, ctx.format) };
}

// --- Write Handlers ---

export async function handlePhaseCreate(
  args: {
    id: string;
    name: string;
    label: string;
    description: string;
    summary?: string;
    after?: string;
    atStart: boolean;
  },
  format: string,
  root: string,
): Promise<CommandResult> {
  validatePhaseId(args.id);

  if (args.atStart && args.after) {
    throw new CliValidationError("invalid_input", "Cannot use both --after and --at-start");
  }
  if (!args.atStart && !args.after) {
    throw new CliValidationError("invalid_input", "Must specify either --after <phase-id> or --at-start");
  }

  let createdPhase: Phase | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    if (state.roadmap.phases.some((p) => p.id === args.id)) {
      throw new CliValidationError("conflict", `Phase "${args.id}" already exists`);
    }

    const phase: Phase = {
      id: args.id,
      label: args.label,
      name: args.name,
      description: args.description,
      ...(args.summary !== undefined && { summary: args.summary }),
    };

    const newPhases = [...state.roadmap.phases];
    if (args.atStart) {
      newPhases.unshift(phase);
    } else {
      const afterIdx = newPhases.findIndex((p) => p.id === args.after);
      if (afterIdx < 0) {
        throw new CliValidationError("not_found", `Phase "${args.after}" not found`);
      }
      newPhases.splice(afterIdx + 1, 0, phase);
    }

    const newRoadmap: Roadmap = { ...state.roadmap, phases: newPhases };
    await writeRoadmapUnlocked(newRoadmap, root);
    createdPhase = phase;
  });

  if (!createdPhase) throw new Error("Phase not created");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(createdPhase), null, 2) };
  }
  return { output: `Created phase ${createdPhase.id}: ${createdPhase.name}` };
}

export async function handlePhaseRename(
  id: string,
  updates: {
    name?: string;
    label?: string;
    description?: string;
    summary?: string;
  },
  format: string,
  root: string,
): Promise<CommandResult> {
  let updatedPhase: Phase | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const idx = state.roadmap.phases.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new CliValidationError("not_found", `Phase "${id}" not found`);
    }

    const existing = state.roadmap.phases[idx]!;
    const phase: Phase = {
      ...existing,
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.label !== undefined && { label: updates.label }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.summary !== undefined && { summary: updates.summary }),
    };

    const newPhases = [...state.roadmap.phases];
    newPhases[idx] = phase;
    const newRoadmap: Roadmap = { ...state.roadmap, phases: newPhases };
    await writeRoadmapUnlocked(newRoadmap, root);
    updatedPhase = phase;
  });

  if (!updatedPhase) throw new Error("Phase not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedPhase), null, 2) };
  }
  return { output: `Updated phase ${updatedPhase.id}: ${updatedPhase.name}` };
}

export async function handlePhaseMove(
  id: string,
  args: { after?: string; atStart: boolean },
  format: string,
  root: string,
): Promise<CommandResult> {
  if (args.atStart && args.after) {
    throw new CliValidationError("invalid_input", "Cannot use both --after and --at-start");
  }
  if (!args.atStart && !args.after) {
    throw new CliValidationError("invalid_input", "Must specify either --after <phase-id> or --at-start");
  }

  let movedPhase: Phase | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const idx = state.roadmap.phases.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new CliValidationError("not_found", `Phase "${id}" not found`);
    }

    const phase = state.roadmap.phases[idx]!;
    const newPhases = state.roadmap.phases.filter((p) => p.id !== id);

    if (args.atStart) {
      newPhases.unshift(phase);
    } else {
      const afterIdx = newPhases.findIndex((p) => p.id === args.after);
      if (afterIdx < 0) {
        throw new CliValidationError("not_found", `Phase "${args.after}" not found`);
      }
      newPhases.splice(afterIdx + 1, 0, phase);
    }

    const newRoadmap: Roadmap = { ...state.roadmap, phases: newPhases };
    await writeRoadmapUnlocked(newRoadmap, root);
    movedPhase = phase;
  });

  if (!movedPhase) throw new Error("Phase not moved");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(movedPhase), null, 2) };
  }
  return { output: `Moved phase ${movedPhase.id}: ${movedPhase.name}` };
}

export async function handlePhaseDelete(
  id: string,
  reassign: string | undefined,
  format: string,
  root: string,
): Promise<CommandResult> {
  if (reassign === id) {
    throw new CliValidationError("invalid_input", `Cannot reassign to the phase being deleted: ${id}`);
  }

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const idx = state.roadmap.phases.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new CliValidationError("not_found", `Phase "${id}" not found`);
    }

    const affectedTickets = state.tickets.filter((t) => t.phase === id);
    const affectedIssues = state.issues.filter((i) => i.phase === id);

    if ((affectedTickets.length > 0 || affectedIssues.length > 0) && !reassign) {
      const parts: string[] = [];
      if (affectedTickets.length > 0) parts.push(`${affectedTickets.length} ticket(s)`);
      if (affectedIssues.length > 0) parts.push(`${affectedIssues.length} issue(s)`);
      throw new CliValidationError(
        "conflict",
        `Cannot delete phase "${id}": ${parts.join(" and ")} reference it. Use --reassign <target-phase> to move them.`,
      );
    }

    if (reassign) {
      if (!state.roadmap.phases.some((p) => p.id === reassign)) {
        throw new CliValidationError("not_found", `Reassignment target phase "${reassign}" not found`);
      }

      const targetLeaves = state.phaseTickets(reassign);
      let maxOrder = targetLeaves.length > 0 ? targetLeaves[targetLeaves.length - 1]!.order : 0;

      const wrapDir = resolve(root, ".story");
      const operations: Array<{ op: "write"; target: string; content: string } | { op: "delete"; target: string }> = [];

      const sortedTickets = [...affectedTickets].sort((a, b) => a.order - b.order);
      for (const ticket of sortedTickets) {
        maxOrder += 10;
        const updated = { ...ticket, phase: reassign, order: maxOrder };
        const parsed = TicketSchema.parse(updated);
        const content = serializeJSON(parsed);
        const target = join(wrapDir, "tickets", `${parsed.id}.json`);
        operations.push({ op: "write", target, content });
      }

      for (const issue of affectedIssues) {
        const updated = { ...issue, phase: reassign };
        const parsed = IssueSchema.parse(updated);
        const content = serializeJSON(parsed);
        const target = join(wrapDir, "issues", `${parsed.id}.json`);
        operations.push({ op: "write", target, content });
      }

      const newPhases = state.roadmap.phases.filter((p) => p.id !== id);
      const newRoadmap: Roadmap = { ...state.roadmap, phases: newPhases };
      const parsedRoadmap = RoadmapSchema.parse(newRoadmap);
      const roadmapContent = serializeJSON(parsedRoadmap);
      const roadmapTarget = join(wrapDir, "roadmap.json");
      operations.push({ op: "write", target: roadmapTarget, content: roadmapContent });

      await runTransactionUnlocked(root, operations);
    } else {
      const newPhases = state.roadmap.phases.filter((p) => p.id !== id);
      const newRoadmap: Roadmap = { ...state.roadmap, phases: newPhases };
      await writeRoadmapUnlocked(newRoadmap, root);
    }
  });

  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id, deleted: true }), null, 2) };
  }
  return { output: `Deleted phase ${id}.` };
}
