import { withProjectLock } from "../../core/project-loader.js";
import { loadRulingsSafe, writeRulingUnlocked } from "../../core/ruling-loader.js";
import {
  buildCitationResolutionContext,
  resolveCitation,
  validateSupersedeCandidate,
} from "../../core/ruling.js";
import { generateCanonicalId } from "../../core/canonical-id.js";
import { ownerTaskForCurrentClient } from "../../autonomous/client-profile.js";
import { summarizeZodIssues, describeSchemaIssues } from "../../core/zod-issues.js";
import {
  RulingSchema,
  RULING_ATTRIBUTIONS,
  type Ruling,
  type RulingAttribution,
} from "../../models/ruling.js";
import type { OwnerTaskLike } from "../../models/types.js";
import {
  formatRuling,
  formatRulingList,
  formatRulingCreateResult,
  formatRulingSupersedeResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

function requireCallerIdentity(clientTaskId: string | undefined): OwnerTaskLike {
  const ownerTask = ownerTaskForCurrentClient(clientTaskId ?? null);
  if (!ownerTask) {
    throw new CliValidationError(
      "invalid_input",
      "Cannot resolve caller identity for this ruling action; run inside a supported client session or pass clientTaskId",
    );
  }
  return { client: ownerTask.client, id: ownerTask.id };
}

function validateOrThrow(candidate: unknown): Ruling {
  const result = RulingSchema.safeParse(candidate);
  if (!result.success) {
    const issues = summarizeZodIssues(result.error);
    throw new CliValidationError("invalid_input", describeSchemaIssues(issues, result.error.issues.length));
  }
  return result.data;
}

// --- Read handlers ---
// Rulings are deliberately NOT part of `ctx.state` (mirrors arrangements,
// T-473 binding item 2): both read handlers call the fail-safe loader
// directly.

export function handleRulingList(
  filters: { scopeTag?: string; superseded?: boolean },
  ctx: CommandContext,
): CommandResult {
  const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries, warnings } = loadRulingsSafe(ctx.root);
  let filtered = rulings;
  if (filters.scopeTag) {
    filtered = filtered.filter((r) => r.scopeTags.includes(filters.scopeTag!));
  }
  const allWarnings = [...warnings];
  if (filters.superseded !== undefined) {
    // Codex round-2 finding 1: a naive successorsByTarget lookup only sees
    // LOADED rulings' own `supersedes` pointers -- an unreadable ruling could
    // hide the true successor, silently letting a superseded ruling pass a
    // `--superseded false` filter as falsely current. Route through the same
    // fail-closed resolver every citation uses (resolveCitation): a ruling
    // only counts as current/superseded when its OWN chain state actually
    // resolves; anything indeterminate is excluded from both filtered sets
    // rather than guessed into either one.
    const rulingCtx = buildCitationResolutionContext(rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries);
    if (scanCompleteness !== "complete" || unavailableIds.size > 0 || hasUnrecoverableEntries) {
      allWarnings.push(
        "ruling ledger scan is incomplete or contains unreadable files; entries whose chain state cannot be verified are excluded from this superseded/current filter",
      );
    }
    filtered = filtered.filter((r) => {
      const resolution = resolveCitation(r.id, rulingCtx);
      return resolution.status === "resolved" && resolution.stale === filters.superseded;
    });
  }
  return { output: formatRulingList(filtered, ctx.format), ...(allWarnings.length > 0 && { warnings: allWarnings }) };
}

export function handleRulingGet(id: string, ctx: CommandContext): CommandResult {
  const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries, warnings } = loadRulingsSafe(ctx.root);
  const ruling = rulings.find((r) => r.id === id);
  if (!ruling) {
    if (unavailableIds.has(id)) {
      return {
        output: formatError("io_error", `Ruling ${id} exists but is currently unreadable`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "io_error",
      };
    }
    // Codex round-3 finding 2: when the directory itself could not be
    // enumerated, we never actually looked for `id` -- claiming "not found"
    // would be a false negative under the same fail-closed read contract
    // resolveCitation already honors (a failed scan means unverifiable, not
    // absent).
    if (scanCompleteness !== "complete") {
      return {
        output: formatError("io_error", `Cannot verify whether ruling ${id} exists: the ruling ledger scan is incomplete`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "io_error",
        ...(warnings.length > 0 && { warnings }),
      };
    }
    return {
      output: formatError("not_found", `Ruling ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const rulingCtx = buildCitationResolutionContext(rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries);
  const resolution = resolveCitation(id, rulingCtx);
  return { output: formatRuling(ruling, ctx.format, resolution), ...(warnings.length > 0 && { warnings }) };
}

// --- Write handlers ---

export async function handleRulingCreate(
  args: {
    text: string;
    attribution: string;
    date: string;
    scopeTags: string[];
    clientTaskId?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (!RULING_ATTRIBUTIONS.includes(args.attribution as RulingAttribution)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown attribution "${args.attribution}": must be one of ${RULING_ATTRIBUTIONS.join(", ")}`,
    );
  }
  const recordedBy = requireCallerIdentity(args.clientTaskId);

  let created: Ruling | undefined;
  await withProjectLock(root, { strict: true }, async () => {
    const candidate = {
      id: generateCanonicalId("r"),
      text: args.text,
      attribution: args.attribution as RulingAttribution,
      recordedBy,
      date: args.date,
      scopeTags: args.scopeTags,
      supersedes: null,
    };
    const ruling = validateOrThrow(candidate);
    await writeRulingUnlocked(ruling, root, { createOnly: true });
    created = ruling;
  });

  if (!created) throw new Error("Ruling not created");
  return { output: formatRulingCreateResult(created, format) };
}

/**
 * Section 9's corrected transaction contract:
 * - `--with <newId>`: three-way branch on `new.supersedes`'s CURRENT value
 *   (ruling #1) -- null -> one-time validated write; already === oldId ->
 *   idempotent no-op; anything else -> refuse, naming the existing chain.
 * - no `--with` (create-and-supersede): construct a brand-new ruling whose
 *   `supersedes` is `oldId` from birth, validated against the candidate
 *   graph before the one `atomicCreate`.
 *
 * Fail-closed precondition (ruling #3): refuses outright while ANY ruling
 * in the project is unreadable or the scan is incomplete -- a chain edit
 * against an unverifiable graph is never attempted.
 */
export async function handleRulingSupersede(
  oldId: string,
  args: {
    withId?: string;
    text?: string;
    attribution?: string;
    date?: string;
    scopeTags?: string[];
    clientTaskId?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  // Mirrors the CLI's own `.conflicts("with", ...)` wiring (register.ts) so
  // an MCP caller -- which has no equivalent yargs-level enforcement -- gets
  // the same refusal instead of `withId` silently winning and text/
  // attribution/date/scopeTags being discarded without a word.
  if (args.withId && (args.text !== undefined || args.attribution !== undefined || args.date !== undefined || args.scopeTags !== undefined)) {
    throw new CliValidationError(
      "invalid_input",
      "withId is mutually exclusive with text/attribution/date/scopeTags: link an existing ruling with withId, or create a new one with the other fields, never both",
    );
  }

  let result: { ruling: Ruling; noop: boolean } | undefined;

  await withProjectLock(root, { strict: true }, async () => {
    const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries } = loadRulingsSafe(root);
    if (scanCompleteness !== "complete" || unavailableIds.size > 0 || hasUnrecoverableEntries) {
      throw new CliValidationError(
        "conflict",
        "Refusing to edit the supersedes chain: the ruling ledger is currently unverifiable (an unreadable ruling or incomplete scan). Fix the unreadable file(s) first.",
      );
    }
    const byId = new Map(rulings.map((r) => [r.id, r]));
    if (!byId.has(oldId)) {
      throw new CliValidationError("not_found", `Ruling ${oldId} not found`);
    }

    if (args.withId) {
      const existing = byId.get(args.withId);
      if (!existing) {
        throw new CliValidationError("not_found", `Ruling ${args.withId} not found`);
      }
      if (existing.supersedes === oldId) {
        result = { ruling: existing, noop: true };
        return;
      }
      if (existing.supersedes !== null) {
        throw new CliValidationError(
          "conflict",
          `Ruling ${args.withId} already supersedes ${existing.supersedes}; refusing to repoint an existing chain link`,
        );
      }
      const refusal = validateSupersedeCandidate(rulings, existing.id, oldId);
      if (refusal) {
        throw new CliValidationError("invalid_input", `Cannot link ${existing.id} to supersede ${oldId}: ${refusal.detail}`);
      }
      const updated = validateOrThrow({ ...existing, supersedes: oldId });
      await writeRulingUnlocked(updated, root);
      result = { ruling: updated, noop: false };
      return;
    }

    if (!args.text || !args.attribution || !args.date) {
      throw new CliValidationError(
        "invalid_input",
        "Specify either --with <existing-ruling-id>, or --text/--attribution/--date to create a new superseding ruling",
      );
    }
    if (!RULING_ATTRIBUTIONS.includes(args.attribution as RulingAttribution)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown attribution "${args.attribution}": must be one of ${RULING_ATTRIBUTIONS.join(", ")}`,
      );
    }
    const recordedBy = requireCallerIdentity(args.clientTaskId);
    const newId = generateCanonicalId("r");
    const refusal = validateSupersedeCandidate(rulings, newId, oldId);
    if (refusal) {
      throw new CliValidationError("invalid_input", `Cannot supersede ${oldId}: ${refusal.detail}`);
    }
    const candidate = validateOrThrow({
      id: newId,
      text: args.text,
      attribution: args.attribution as RulingAttribution,
      recordedBy,
      date: args.date,
      scopeTags: args.scopeTags ?? [],
      supersedes: oldId,
    });
    await writeRulingUnlocked(candidate, root, { createOnly: true });
    result = { ruling: candidate, noop: false };
  });

  if (!result) throw new Error("Ruling supersede did not complete");
  return { output: formatRulingSupersedeResult(result.ruling, result.noop, format) };
}
