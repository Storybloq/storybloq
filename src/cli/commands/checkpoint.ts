/**
 * T-537 S5: the `checkpoint` command family. Each handler is shared by the CLI
 * and the MCP tools, so the two surfaces refuse and answer the same way. A
 * lifecycle change names the state the caller last saw (generation, revision
 * and digest, as `checkpoint list` or `ticket get` prints them); the handler
 * compares it under the project lock and refuses a stale one.
 */
import { loadProject } from "../../core/project-loader.js";
import {
  attachCheckpoint,
  changeCheckpoint,
  createCheckpoint,
  reopenCheckpoint,
  resolveCheckpoint,
  retireCheckpoint,
  type CheckpointContentInput,
  type ExpectedCheckpoint,
} from "../../core/checkpoint-lifecycle.js";
import { enableCheckpoints } from "../../core/checkpoint-enable.js";
import { CHECKPOINT_KINDS, hasOwnerCheckpoint } from "../../core/owner-checkpoint.js";
import { checkpointSummary, type CheckpointSummary } from "../../core/checkpoint-display.js";
import { escapeMarkdownInline, formatCheckpointLine, successEnvelope } from "../../core/output-formatter.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import { displayIdOf } from "../../core/resolver.js";
import type { Ticket } from "../../models/ticket.js";
import type { OutputFormat } from "../../models/types.js";
import { CliValidationError, todayISO } from "../helpers.js";
import type { CommandResult } from "../types.js";

function done(verb: string, ticket: Ticket, format: OutputFormat, extra: Record<string, unknown> = {}): CommandResult {
  const summary = checkpointSummary(ticket);
  if (format === "json") return { output: JSON.stringify(successEnvelope({ ...summary, ...extra }), null, 2) };
  return { output: `${verb} ${escapeMarkdownInline(sanitizeDisplayText(displayIdOf(ticket)))}.\n${summary ? formatCheckpointLine(summary) : ""}` };
}

/** Parses the reviewed content a create, attach or change carries. */
export function checkpointContent(input: { kind?: string; question?: string; criteria?: string; evidenceRefs?: readonly string[] }): CheckpointContentInput {
  const kind = input.kind;
  if (kind === undefined || !(CHECKPOINT_KINDS as readonly string[]).includes(kind)) {
    throw new CliValidationError("invalid_input", `A checkpoint kind must be one of: ${CHECKPOINT_KINDS.join(", ")}`);
  }
  if (kind === "decision" && !input.question) throw new CliValidationError("invalid_input", "A decision checkpoint needs a question");
  if (kind === "acceptance" && !input.criteria) throw new CliValidationError("invalid_input", "An acceptance checkpoint needs criteria");
  return {
    kind: kind as CheckpointContentInput["kind"],
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
    evidenceRefs: [...(input.evidenceRefs ?? [])],
  };
}

/** The expected state a change names; every part is required. */
export function expectedCheckpoint(input: { generation?: number; revision?: number; digest?: string }): ExpectedCheckpoint {
  const { generation, revision, digest } = input;
  if (!Number.isInteger(generation) || !Number.isInteger(revision) || typeof digest !== "string" || digest.length === 0) {
    throw new CliValidationError(
      "invalid_input",
      "Name the checkpoint state you last saw: generation, revision and digest (from `storybloq checkpoint list` or `ticket get`)",
    );
  }
  return { generation: generation!, revision: revision!, digest };
}

export async function handleCheckpointEnable(format: OutputFormat, root: string): Promise<CommandResult> {
  const result = await enableCheckpoints(root);
  if (format === "json") return { output: JSON.stringify(successEnvelope(result), null, 2) };
  if (result.status === "already") return { output: "Owner checkpoints are already enabled." };
  return { output: result.team ? "Owner checkpoints enabled; commit .story/config.json and .story/.gitattributes together." : "Owner checkpoints enabled." };
}

export interface CheckpointCreateInput {
  readonly title: string;
  readonly description?: string;
  readonly phase?: string | null;
  readonly blockedBy?: readonly string[];
  readonly parentTicket?: string | null;
  readonly owner: string;
  readonly kind?: string;
  readonly question?: string;
  readonly criteria?: string;
  readonly evidenceRefs?: readonly string[];
  readonly actor?: string;
}

export async function handleCheckpointCreate(input: CheckpointCreateInput, format: OutputFormat, root: string): Promise<CommandResult> {
  const ticket = await createCheckpoint(root, {
    title: input.title,
    description: input.description ?? "",
    phase: input.phase ?? null,
    ...(input.blockedBy ? { blockedBy: [...input.blockedBy] } : {}),
    ...(input.parentTicket !== undefined ? { parentTicket: input.parentTicket } : {}),
    owner: input.owner,
    content: checkpointContent(input),
    ...(input.actor ? { actor: input.actor } : {}),
  });
  return done("Created checkpoint", ticket, format);
}

export async function handleCheckpointAttach(
  id: string,
  input: { owner: string; kind?: string; question?: string; criteria?: string; evidenceRefs?: readonly string[]; actor?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const ticket = await attachCheckpoint(root, id, { owner: input.owner, content: checkpointContent(input), ...(input.actor ? { actor: input.actor } : {}) });
  return done("Attached a checkpoint to", ticket, format);
}

export async function handleCheckpointResolve(
  id: string,
  input: {
    generation?: number; revision?: number; digest?: string; response: string; artifactRef?: string; actor?: string;
    /** Also record the response as an accepted ruling with this attribution, in the same transaction. */
    rulingAttribution?: string; rulingScopeTags?: readonly string[]; clientTaskId?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const { ticket, rulingId } = await resolveCheckpoint(root, id, expectedCheckpoint(input), {
    response: input.response,
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.rulingAttribution !== undefined
      ? {
          ruling: {
            text: input.response,
            attribution: input.rulingAttribution,
            date: todayISO(),
            scopeTags: [...(input.rulingScopeTags ?? [])],
            ...(input.clientTaskId ? { clientTaskId: input.clientTaskId } : {}),
          },
        }
      : {}),
  });
  if (rulingId === undefined) return done("Resolved checkpoint", ticket, format);
  if (format === "json") return done("Resolved checkpoint", ticket, format, { rulingId });
  return done(`Resolved checkpoint (ruling ${rulingId})`, ticket, format);
}

export async function handleCheckpointChange(
  id: string,
  input: { generation?: number; revision?: number; digest?: string; kind?: string; question?: string; criteria?: string; evidenceRefs?: readonly string[]; actor?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const ticket = await changeCheckpoint(root, id, expectedCheckpoint(input), checkpointContent(input), input.actor);
  return done("Changed checkpoint", ticket, format);
}

export async function handleCheckpointReopen(
  id: string,
  input: { generation?: number; revision?: number; digest?: string; reason?: string; actor?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const ticket = await reopenCheckpoint(root, id, expectedCheckpoint(input), input.actor, input.reason);
  return done("Reopened checkpoint", ticket, format);
}

export async function handleCheckpointRetire(
  id: string,
  input: { generation?: number; revision?: number; digest?: string; reason?: string; actor?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const reason = input.reason?.trim();
  if (!reason) throw new CliValidationError("invalid_input", "Retiring a checkpoint needs a reason");
  const ticket = await retireCheckpoint(root, id, expectedCheckpoint(input), reason, input.actor);
  return done("Retired checkpoint", ticket, format);
}

/** `resolve` restricted to a checkpoint ticket, so a typo cannot settle some other conflict. */
export async function handleCheckpointResolveConflict(
  id: string,
  input: { use?: "ours" | "theirs"; field?: string; value?: unknown; actor?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const { state } = await loadProject(root);
  const found = state.resolveTicketRef(id);
  if (found.kind !== "found") throw new CliValidationError("not_found", `Ticket ${id} not found`);
  const conflicts = (found.item as Record<string, unknown>)._conflicts;
  const sides = Array.isArray(conflicts) ? (conflicts as Array<Record<string, unknown>>).flatMap((c) => [c.base, c.ours, c.theirs]) : [];
  const carries = hasOwnerCheckpoint(found.item) || sides.some((v) => v !== null && typeof v === "object" && hasOwnerCheckpoint(v));
  if (!carries) throw new CliValidationError("invalid_input", `${id} is not an owner checkpoint; use \`storybloq resolve\` for other conflicts`);
  const { handleResolve } = await import("./conflicts.js");
  return handleResolve(id, root, { ...input, format });
}

export async function handleCheckpointList(format: OutputFormat, root: string, opts: { state?: string } = {}): Promise<CommandResult> {
  const { state } = await loadProject(root);
  const all = state.tickets
    .map((t) => checkpointSummary(t))
    .filter((s): s is CheckpointSummary => s !== null)
    .filter((s) => opts.state === undefined || s.state === opts.state);
  if (format === "json") return { output: JSON.stringify(successEnvelope(all), null, 2) };
  if (all.length === 0) return { output: "No owner checkpoints." };
  return { output: all.map(formatCheckpointLine).join("\n") };
}
