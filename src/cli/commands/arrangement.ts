import { withProjectLock, writeTicketUnlocked, writeIssueUnlocked } from "../../core/project-loader.js";
import { loadArrangementsSafe, writeArrangementUnlocked } from "../../core/arrangement-loader.js";
import { isArrangementConflicted } from "../../core/arrangement-authority.js";
import { earmarkMatchesArrangement } from "../../core/earmarks.js";
import { generateCanonicalId } from "../../core/canonical-id.js";
import { summarizeZodIssues, describeSchemaIssues } from "../../core/zod-issues.js";
import {
  formatArrangement,
  formatArrangementList,
  formatArrangementCreateResult,
  formatArrangementUpdateResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  ArrangementSchema,
  ARRANGEMENT_LIFECYCLE,
  type Arrangement,
  type ArrangementLifecycle,
  type ArrangementParty,
} from "../../models/arrangement.js";
import { TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX, ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX, type OutputFormat } from "../../models/types.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { ProjectState } from "../../core/project-state.js";

/**
 * Resolves a `--bounds` ref (display-form or canonical, per binding item 1)
 * against the fresh `ProjectState` and returns the resolved item's own
 * `.id`, never the raw typed ref -- this normalizes a valid post-migration
 * display-id reference to its canonical form while leaving a legacy ref
 * untouched (a legacy item's `id` already equals its display form), so a
 * persisted bound is never ambiguous even if the display id it was typed as
 * later collides. Ticket and issue ref patterns are syntactically disjoint
 * (`T-`/`t-` vs `ISS-`/`i-`), so there is no try-one-then-fall-back-to-the-
 * other ambiguity.
 */
function resolveBoundRef(ref: string, state: ProjectState): string {
  const isTicketRef = TICKET_ID_REGEX.test(ref) || TICKET_CANONICAL_ID_REGEX.test(ref);
  const isIssueRef = ISSUE_ID_REGEX.test(ref) || ISSUE_CANONICAL_ID_REGEX.test(ref);
  if (!isTicketRef && !isIssueRef) {
    throw new CliValidationError("invalid_input", `Bound ref "${ref}" is neither a ticket nor an issue reference`);
  }
  const result = isTicketRef ? state.resolveTicketRef(ref) : state.resolveIssueRef(ref);
  if (result.kind === "missing") {
    throw new CliValidationError("invalid_input", `Bound ref "${ref}" not found`);
  }
  if (result.kind === "ambiguous") {
    throw new CliValidationError("invalid_input", `Bound ref "${ref}" is ambiguous`);
  }
  return result.item.id;
}

/**
 * Validates the assembled record against `ArrangementSchema` (including its
 * party-topology `superRefine`) BEFORE the writer's own defensive parse, so
 * a two-workers-no-pen or duplicate-identity payload reports `invalid_input`
 * with field detail rather than reaching `writeArrangementUnlocked`'s
 * internal `.parse()` and surfacing as an unclassified `io_error`.
 */
function validateOrThrow(candidate: unknown): Arrangement {
  const result = ArrangementSchema.safeParse(candidate);
  if (!result.success) {
    const issues = summarizeZodIssues(result.error);
    throw new CliValidationError("invalid_input", describeSchemaIssues(issues, result.error.issues.length));
  }
  return result.data;
}

// --- Read handlers ---
// Arrangements are deliberately NOT part of `ctx.state` (binding item 2:
// off the strict ProjectState load path), so both read handlers call the
// fail-safe loader directly, exactly as `handleStatus` does.

export function handleArrangementList(
  filters: { lifecycle?: string },
  ctx: CommandContext,
): CommandResult {
  const { arrangements } = loadArrangementsSafe(ctx.root);
  let filtered = arrangements;
  if (filters.lifecycle) {
    if (!ARRANGEMENT_LIFECYCLE.includes(filters.lifecycle as ArrangementLifecycle)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown arrangement lifecycle "${filters.lifecycle}": must be one of ${ARRANGEMENT_LIFECYCLE.join(", ")}`,
      );
    }
    filtered = filtered.filter((a) => a.lifecycle === filters.lifecycle);
  }
  return { output: formatArrangementList(filtered, ctx.format) };
}

export function handleArrangementGet(id: string, ctx: CommandContext): CommandResult {
  const { arrangements } = loadArrangementsSafe(ctx.root);
  const arrangement = arrangements.find((a) => a.id === id);
  if (!arrangement) {
    return {
      output: formatError("not_found", `Arrangement ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatArrangement(arrangement, ctx.format) };
}

// --- Write handlers ---

export async function handleArrangementCreate(
  args: {
    bounds: string[];
    parties: ArrangementParty[];
    onIrreversibleWork: "hold" | "escalate";
    onReversibleWork?: "hold" | "escalate" | "proceed";
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (args.bounds.length === 0) {
    throw new CliValidationError("invalid_input", "At least one --bounds ref is required");
  }

  let created: Arrangement | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const resolvedBounds = args.bounds.map((ref) => resolveBoundRef(ref, state));
    const id = generateCanonicalId("a");
    const today = new Date().toISOString().slice(0, 10);
    const candidate = {
      id,
      lifecycle: "active" as const,
      bounds: resolvedBounds,
      parties: args.parties,
      gates: [],
      unreachability: {
        onIrreversibleWork: args.onIrreversibleWork,
        ...(args.onReversibleWork !== undefined && { onReversibleWork: args.onReversibleWork }),
      },
      createdDate: today,
    };
    const arrangement = validateOrThrow(candidate);
    await writeArrangementUnlocked(arrangement, root, { createOnly: true });
    created = arrangement;
  });

  if (!created) throw new Error("Arrangement not created");
  return { output: formatArrangementCreateResult(created, format) };
}

/**
 * Section 5: closing an arrangement retracts everything it ever authorized.
 * Called INSIDE `handleArrangementUpdate`'s existing lock, never a
 * separately-locking wrapper (confirmed nesting-deadlock risk, round 1) --
 * `earmarkMatchesArrangement` (earmarks.ts) is the pure predicate, this is
 * just the scan-and-write.
 */
async function clearEarmarkUnlocked(state: ProjectState, arrangementId: string, root: string): Promise<void> {
  for (const ticket of state.tickets) {
    if (earmarkMatchesArrangement(ticket.earmark, arrangementId)) {
      await writeTicketUnlocked({ ...ticket, earmark: null }, root);
    }
  }
  for (const issue of state.issues) {
    if (earmarkMatchesArrangement(issue.earmark, arrangementId)) {
      await writeIssueUnlocked({ ...issue, earmark: null }, root);
    }
  }
}

export async function handleArrangementUpdate(
  id: string,
  updates: { lifecycle?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (updates.lifecycle === undefined) {
    throw new CliValidationError("invalid_input", "Specify at least one field to update: lifecycle");
  }
  if (!ARRANGEMENT_LIFECYCLE.includes(updates.lifecycle as ArrangementLifecycle)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown arrangement lifecycle "${updates.lifecycle}": must be one of ${ARRANGEMENT_LIFECYCLE.join(", ")}`,
    );
  }

  let updated: Arrangement | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    // Arrangements are off the strict ProjectState load path (binding item
    // 2), so the existing record comes from the fail-safe loader, not from
    // `state` -- consistent with the read handlers above. `state` itself is
    // still needed here (section 5) to scan tickets/issues for earmarks to
    // retract on close.
    const { arrangements } = loadArrangementsSafe(root);
    const existing = arrangements.find((a) => a.id === id);
    if (!existing) {
      throw new CliValidationError("not_found", `Arrangement ${id} not found`);
    }
    if (isArrangementConflicted(existing)) {
      throw new CliValidationError(
        "invalid_input",
        `Arrangement ${id} has unresolved merge conflicts; resolve with "storybloq resolve ${id}" before updating it`,
      );
    }
    const candidate = { ...existing, lifecycle: updates.lifecycle as ArrangementLifecycle };
    const arrangement = validateOrThrow(candidate);
    // Binding item 3: the ordinary atomic-replace path, `createOnly` omitted.
    await writeArrangementUnlocked(arrangement, root);
    if (arrangement.lifecycle === "closed") {
      await clearEarmarkUnlocked(state, arrangement.id, root);
    }
    updated = arrangement;
  });

  if (!updated) throw new Error("Arrangement not updated");
  return { output: formatArrangementUpdateResult(updated, format) };
}
