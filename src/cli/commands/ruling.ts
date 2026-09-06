import { stat } from "node:fs/promises";
import {
  withProjectLock,
  runTransactionUnlocked,
  prepareTicketWrite,
  prepareIssueWrite,
  TransactionRecoveryPendingError,
} from "../../core/project-loader.js";
import {
  loadRulingsSafe,
  writeRulingUnlocked,
  prepareRulingWrite,
} from "../../core/ruling-loader.js";
import { isIssueShapedRef, isTicketShapedRef } from "../../core/review-coverage.js";
import type { ProjectState } from "../../core/project-state.js";
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
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";
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

/** One cited item, resolved to the record that will be rewritten. */
type CitedTarget =
  | { kind: "ticket"; item: Ticket }
  | { kind: "issue"; item: Issue };

/**
 * Resolves every `--cites` ref against loaded state and deduplicates by the
 * resolved record, NOT by the ref the caller typed.
 *
 * Deduplication is load bearing rather than tidiness. `runTransactionUnlocked`
 * derives its temp path deterministically as `${target}.${process.pid}.tmp`, so
 * two operations on one target share it: the first `rename` consumes it and the
 * second fails ENOENT AFTER the journal is marked `commitStarted`. A repeated
 * ref would therefore be a mid-commit failure, not a harmless no-op. Both
 * `--cites T-001 --cites T-001` and a display/canonical pair naming one item
 * reach that, because `resolveTicketRef` accepts either form.
 *
 * An unresolvable or ambiguous ref REFUSES the whole create, before anything is
 * written: a ruling whose citation silently did not land is worse than no
 * ruling, because the recorder would believe it is reachable.
 */
function resolveCitedTargets(state: ProjectState, cites: readonly string[]): CitedTarget[] {
  const byRecord = new Map<string, CitedTarget>();
  for (const ref of cites) {
    const trimmed = ref.trim();
    if (trimmed === "") {
      throw new CliValidationError("invalid_input", "Empty item ref in --cites");
    }
    const ticketShaped = isTicketShapedRef(trimmed);
    const issueShaped = isIssueShapedRef(trimmed);
    if (!ticketShaped && !issueShaped) {
      throw new CliValidationError(
        "invalid_input",
        `Cannot cite "${trimmed}": rulings are cited by tickets and issues only (T- or ISS- form, or a canonical t-/i- id)`,
      );
    }
    const resolved = issueShaped ? state.resolveIssueRef(trimmed) : state.resolveTicketRef(trimmed);
    if (resolved.kind === "missing") {
      throw new CliValidationError("not_found", `Cannot cite "${trimmed}": no such item`);
    }
    if (resolved.kind === "ambiguous") {
      throw new CliValidationError(
        "conflict",
        `Cannot cite "${trimmed}": ambiguous, matches ${resolved.matches.map((m) => m.id).join(", ")}`,
      );
    }
    const kind = issueShaped ? "issue" : "ticket";
    // The MAP keyed by the RESOLVED record is the dedupe. Keying by the ref the
    // caller typed would not collapse a display/canonical pair naming one item,
    // and `Map.set` on an existing key keeps its original insertion position, so
    // first-seen order survives. An explicit has()/continue guard here was
    // tried and is provably equivalent to the `set` alone, so it is not kept:
    // a line that looks like the defence while the Map is doing the work
    // invites someone to "simplify" the Map away later.
    const key = `${kind}:${resolved.item.id}`;
    byRecord.set(
      key,
      kind === "issue"
        ? { kind: "issue", item: resolved.item as Issue }
        : { kind: "ticket", item: resolved.item as Ticket },
    );
  }
  return [...byRecord.values()];
}

export async function handleRulingCreate(
  args: {
    text: string;
    attribution: string;
    date: string;
    scopeTags: string[];
    cites?: string[];
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
  const cites = args.cites ?? [];

  let created: Ruling | undefined;
  // ONE LOCK. This handler already holds `.story/.lock`, which is NOT
  // re-entrant, so the citation appends happen inside it rather than through a
  // nested `withProjectLock`. Measured rather than assumed: a nested
  // acquisition does not hang forever, it spins to `project-lock.ts`'s
  // `DEFAULT_DEADLINE_MS` (5,000) and then THROWS a lock-acquisition error, so
  // every cited create would fail five seconds in. Same verdict either way,
  // different symptom, and the symptom is what a future debugger will see.
  await withProjectLock(root, { strict: true }, async (loadResult) => {
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

    if (cites.length === 0) {
      await writeRulingUnlocked(ruling, root, { createOnly: true });
      created = ruling;
      return;
    }

    const targets = resolveCitedTargets(loadResult.state, cites);

    // SET-UNION, never replacement. `resolveCitesRulingsInput`'s
    // full-replacement convention is right for an explicit `--cites-ruling`
    // update and wrong here: this path adds one citation and must leave every
    // other one standing. Items whose set does not change contribute no write.
    const itemOps: Array<{ op: "write"; target: string; content: string }> = [];
    for (const target of targets) {
      const existing = target.item.citesRulings ?? [];
      if (existing.includes(ruling.id)) continue;
      const next = [...existing, ruling.id];
      const prepared =
        target.kind === "issue"
          ? await prepareIssueWrite({ ...target.item, citesRulings: next }, root)
          : await prepareTicketWrite({ ...target.item, citesRulings: next }, root);
      itemOps.push({ op: "write", target: prepared.target, content: prepared.content });
    }

    // Carries every invariant the transaction does not: schema parse, id check,
    // the serialized-byte cap the READER also applies, the `.story/rulings`
    // mkdir the first ruling in a project needs, and `guardPath`.
    const rulingPrepared = await prepareRulingWrite(ruling, root);

    // No-overwrite, and weaker than `atomicCreate` on purpose: `rename` always
    // overwrites, so the transaction cannot express create-only. Under this
    // exclusive lock the check is exact. It defends against a minted-id
    // collision and a leftover file, NOT against a concurrent writer -- the
    // lock is what does that.
    if (await pathExists(rulingPrepared.target)) {
      throw new CliValidationError(
        "conflict",
        `Ruling ${ruling.id} already exists; refusing to overwrite it`,
      );
    }

    // Items FIRST, ruling LAST. The transaction renames in order, and forward
    // recovery completes a partial commit at the next lock acquisition, so this
    // only decides which residue is visible in the window between. Items-first
    // leaves citations pointing at a ruling that does not exist yet, which
    // resolves as `missing`: a status every renderer prints as a warning and the
    // plan-pin guard refuses on. Ruling-first would leave a ruling that nothing
    // cites, which is silent and is precisely the failure this ticket exists to
    // prevent. Fail loud, not dark.
    try {
      await runTransactionUnlocked(root, [
        ...itemOps,
        { op: "write", target: rulingPrepared.target, content: rulingPrepared.content },
      ]);
    } catch (err) {
      // The plan's recovery-pending outcome, reported by NAME rather than
      // collapsed into "Transaction failed".
      //
      // After the commit begins, some targets are already renamed and the
      // journal is left in place so `doRecoverTransaction` finishes the rest at
      // the next lock acquisition. The caller must not retry: a retry mints a
      // second ruling beside the one recovery is about to complete, and with
      // items-first ordering the citations already on disk point at THIS id. So
      // the id is in the message -- it is the only handle the operator has on
      // what recovery will finish.
      if (err instanceof TransactionRecoveryPendingError) {
        throw new CliValidationError(
          "io_error",
          `Ruling ${ruling.id}: the commit had already begun and forward recovery is pending. `
            + `Do NOT retry this create: it would add a second ruling beside the one recovery completes. `
            + `Run \`storybloq ruling get ${ruling.id}\` and \`storybloq validate\` to see what landed, then continue from there. `
            // The underlying failure survives the translation too. Lock
            // ownership lost and an EIO on a rename call for different
            // responses, and the wrapper above carries it for exactly that
            // reason -- dropping it one layer up would undo the point.
            + `Underlying failure: ${err.message}`,
        );
      }
      throw err;
    }
    created = ruling;
  });

  if (!created) throw new Error("Ruling not created");
  return { output: formatRulingCreateResult(created, format) };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
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
