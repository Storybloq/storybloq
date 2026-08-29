import { execFileSync } from "node:child_process";
import { withProjectLock } from "../../core/project-loader.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { isArrangementConflicted } from "../../core/arrangement-authority.js";
import { readGateAcksForListing, writeGateAckUnlocked, writeGateAckContested } from "../../core/gate-ack-loader.js";
import { readBoundedRegularFile, sha256Bytes, PLAN_ACK_MAX_BYTES } from "../../core/pin-utils.js";
import { summarizeZodIssues, describeSchemaIssues } from "../../core/zod-issues.js";
import {
  formatGateAck,
  formatGateAckList,
  formatGateAckCreateResult,
  formatGateAckContestResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import { GateAckSchema, computeGateAckId, type GateAck, type GateAckPin } from "../../models/gate-ack.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { ProjectState } from "../../core/project-state.js";
import type { OutputFormat } from "../../models/types.js";

function resolveCanonicalTicketRef(ref: string, state: ProjectState): string {
  const result = state.resolveTicketRef(ref);
  if (result.kind === "missing") throw new CliValidationError("invalid_input", `Ticket ref "${ref}" not found`);
  if (result.kind === "ambiguous") throw new CliValidationError("invalid_input", `Ticket ref "${ref}" is ambiguous`);
  return result.item.id;
}

function computePlanHashPin(planFile: string): GateAckPin {
  const result = readBoundedRegularFile(planFile, PLAN_ACK_MAX_BYTES);
  if (result.status !== "ok") {
    throw new CliValidationError("invalid_input", `Cannot read --plan-file "${planFile}": ${result.reason}`);
  }
  return { kind: "plan-hash", sha256: sha256Bytes(result.bytes) };
}

/** v1 constraint, stated not silent: SHA-1 object format only (T-474 R1-FIX 12). */
function computeTreeDigestPin(root: string): GateAckPin {
  let objectFormat: string;
  try {
    objectFormat = execFileSync("git", ["-C", root, "rev-parse", "--show-object-format"], { encoding: "utf-8" }).trim();
  } catch (err) {
    throw new CliValidationError("invalid_input", `Cannot determine git object format: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (objectFormat !== "sha1") {
    throw new CliValidationError("invalid_input", `gate-ack v1 only supports SHA-1 git repositories (found: ${objectFormat})`);
  }
  try {
    // `git write-tree` is standard, idempotent git plumbing (used internally
    // by `git commit` itself) -- content-addressed, no working-tree mutation.
    const treeId = execFileSync("git", ["-C", root, "write-tree"], { encoding: "utf-8" }).trim();
    const parentSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    return { kind: "tree-digest", parentSha, treeId };
  } catch (err) {
    throw new CliValidationError("invalid_input", `Cannot compute staged tree pin: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Read handlers ---
// Gate-acks are deliberately off the strict ProjectState load path, exactly
// like T-473's arrangements -- both read handlers call the loader directly.

export function handleGateAckGet(id: string, ctx: CommandContext): CommandResult {
  const { acks } = readGateAcksForListing(ctx.root);
  const ack = acks.find((a) => a.id === id);
  if (!ack) {
    return {
      output: formatError("not_found", `Gate-ack ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatGateAck(ack, ctx.format) };
}

export function handleGateAckList(filters: { arrangement?: string; ticket?: string }, ctx: CommandContext): CommandResult {
  const { acks } = readGateAcksForListing(ctx.root);
  let filtered = acks;
  if (filters.arrangement) filtered = filtered.filter((a) => a.arrangementId === filters.arrangement);
  if (filters.ticket) filtered = filtered.filter((a) => a.ticketRef === filters.ticket);
  return { output: formatGateAckList(filtered, ctx.format) };
}

// --- Write handlers ---

export async function handleGateAckCreate(
  args: {
    arrangement: string;
    gate: string;
    ticket: string;
    planFile?: string;
    fromStaged?: boolean;
    codexSessionId?: string;
    verdict?: string;
    rounds?: number;
    deltas?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const pinSourceCount = (args.planFile ? 1 : 0) + (args.fromStaged ? 1 : 0);
  if (pinSourceCount !== 1) {
    throw new CliValidationError("invalid_input", "Specify exactly one of --plan-file or --from-staged");
  }

  let created: GateAck | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const { arrangements } = loadArrangementsSafe(root);
    const arrangement = arrangements.find((a) => a.id === args.arrangement);
    if (!arrangement) {
      throw new CliValidationError("not_found", `Arrangement ${args.arrangement} not found`);
    }
    if (isArrangementConflicted(arrangement)) {
      throw new CliValidationError(
        "invalid_input",
        `Arrangement ${args.arrangement} has unresolved merge conflicts; resolve with "storybloq resolve ${args.arrangement}" before creating a gate-ack against it`,
      );
    }
    const gate = arrangement.gates.find((g) => g.name === args.gate);
    if (!gate) {
      throw new CliValidationError("invalid_input", `Arrangement ${args.arrangement} has no gate named "${args.gate}"`);
    }

    const ticketRef = resolveCanonicalTicketRef(args.ticket, state);
    const pin = args.planFile ? computePlanHashPin(args.planFile) : computeTreeDigestPin(root);
    const id = computeGateAckId(arrangement.id, gate.name, ticketRef, pin);
    const reviewTrail = args.verdict
      ? {
          present: true as const,
          verdict: args.verdict,
          ...(args.codexSessionId !== undefined && { codexSessionId: args.codexSessionId }),
          ...(args.rounds !== undefined && { rounds: args.rounds }),
        }
      : { present: false as const };

    const candidate = {
      id,
      arrangementId: arrangement.id,
      gateName: gate.name,
      ackRole: gate.ackRole, // derived from the gate's own declaration, never freely chosen by the acking party
      ticketRef,
      pin,
      decidedAt: new Date().toISOString(),
      ...(args.deltas !== undefined && { deltas: args.deltas }),
      reviewTrail,
      contested: false,
    };
    const result = GateAckSchema.safeParse(candidate);
    if (!result.success) {
      const issues = summarizeZodIssues(result.error);
      throw new CliValidationError("invalid_input", describeSchemaIssues(issues, result.error.issues.length));
    }
    created = await writeGateAckUnlocked(result.data, root);
  });

  if (!created) throw new Error("Gate-ack not created");
  return { output: formatGateAckCreateResult(created, format) };
}

export async function handleGateAckContest(id: string, reason: string, format: OutputFormat, root: string): Promise<CommandResult> {
  if (!reason.trim()) {
    throw new CliValidationError("invalid_input", "--reason must not be empty");
  }

  let updated: GateAck | undefined;

  await withProjectLock(root, { strict: true }, async () => {
    updated = await writeGateAckContested(id, reason, root);
  });

  if (!updated) throw new Error("Gate-ack not contested");
  return { output: formatGateAckContestResult(updated, format) };
}
