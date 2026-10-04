import { stat } from "node:fs/promises";
import { join } from "node:path";
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
  buildSuccessorIndex,
  resolveCitation,
  validateAcceptCandidate,
  validateSupersedeCandidate,
} from "../../core/ruling.js";
import {
  classifyLifecycle,
  isEffectivelyAccepted,
  lifecycleOf,
  makeAcceptance,
  payloadDigest,
  proposalsAgainst,
  type RulingLifecycle,
} from "../../core/ruling-lifecycle.js";
import { formatDecisionsListing } from "../../core/decisions-listing.js";
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
  formatRulingProposeResult,
  formatRulingAcceptResult,
  formatRulingWithdrawResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import { isTeamModeConfig, RULING_LIFECYCLE_MIN_CLI_VERSION } from "../../core/team-capabilities.js";
import { rulingLifecycleReadiness } from "../../core/team-setup.js";
import type { Config } from "../../models/config.js";
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

/** T-522: the four narrative flags, shared by create, supersede and propose. */
export interface NarrativeArgs {
  context?: string;
  alternatives?: string;
  consequences?: string;
  reconsiderWhen?: string;
}

function narrativeFrom(args: NarrativeArgs): Ruling["narrative"] | undefined {
  const n: Record<string, string> = {};
  for (const key of ["context", "alternatives", "consequences", "reconsiderWhen"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) n[key] = v;
  }
  return Object.keys(n).length > 0 ? n : undefined;
}

export const RULING_LIFECYCLES: readonly RulingLifecycle[] = ["proposed", "accepted", "withdrawn", "superseded", "quarantined", "conflicted"];

/**
 * T-522 plan section 8: in a team-mode project EVERY ruling write (all of
 * them produce 1.16 records) refuses until `team setup` has raised the fence
 * to 1.16.0 and written the rulings merge attribute. Reads are never refused.
 * Checked inside the lock, against the config the lock loaded.
 *
 * Ordering note: `withProjectLock` finishes any interrupted transaction whose
 * commit had already begun BEFORE it hands the config to this callback. That
 * is forward-only recovery of a write that was accepted while the project was
 * ready (every lock holder performs it, a ticket update included), not a new
 * ruling write, so this precondition deliberately does not gate it: refusing
 * would strand a half-renamed commit for the next unrelated command to finish.
 */
function assertRulingWritesEnabled(config: Config, root: string, rulingId: string): void {
  if (!isTeamModeConfig(config)) return;
  const readiness = rulingLifecycleReadiness(join(root, ".story"), config.team?.minCliVersion, rulingId);
  if (readiness.fenceOk && readiness.attributeOk && readiness.registration.ok) return;
  const gaps: string[] = [];
  if (!readiness.fenceOk) gaps.push(`team.minCliVersion is ${config.team?.minCliVersion ?? "unset"}, below ${RULING_LIFECYCLE_MIN_CLI_VERSION}`);
  if (!readiness.attributeOk) gaps.push(`git does not resolve \`merge=storybloq-json\` for .story/rulings/${rulingId}.json (\`.story/.gitattributes\` needs the \`rulings/*.json merge=storybloq-json\` line, unoverridden)`);
  else if (!readiness.registration.ok) gaps.push(readiness.registration.message);
  throw new CliValidationError(
    "conflict",
    `Ruling writes are disabled in this team project until \`storybloq team setup\` enables 1.16 rulings (${gaps.join("; ")}). Run it on a ${RULING_LIFECYCLE_MIN_CLI_VERSION}+ CLI; reads are unaffected.`,
  );
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
  filters: { scopeTag?: string; superseded?: boolean; status?: string },
  ctx: CommandContext,
): CommandResult {
  const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries, warnings, lifecycleById } = loadRulingsSafe(ctx.root);
  let filtered = rulings;
  if (filters.scopeTag) {
    filtered = filtered.filter((r) => r.scopeTags.includes(filters.scopeTag!));
  }
  const allWarnings = [...warnings];
  if (filters.status !== undefined) {
    // T-522: `accepted` means the effectively accepted set minus superseded
    // (what binds NOW); `superseded` is its own bucket; the legacy form is
    // folded into `accepted` because a 1.15 record is accepted by shape.
    if (!RULING_LIFECYCLES.includes(filters.status as RulingLifecycle)) {
      throw new CliValidationError("invalid_input", `Unknown status "${filters.status}": must be one of ${RULING_LIFECYCLES.join(", ")}`);
    }
    filtered = filtered.filter((r) => {
      const lc = lifecycleById.get(r.id);
      if (filters.status === "accepted") return lc === "accepted" || lc === "accepted-legacy";
      return lc === filters.status;
    });
  }
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
  if (ctx.format === "md") {
    // T-522 plan section 6: the Markdown list IS the Decisions listing.
    const index = buildSuccessorIndex(rulings);
    const output = formatDecisionsListing(filtered, lifecycleById, { index }, [...ctx.state.tickets, ...ctx.state.issues]);
    return { output, ...(allWarnings.length > 0 && { warnings: allWarnings }) };
  }
  return { output: formatRulingList(filtered, ctx.format, lifecycleById), ...(allWarnings.length > 0 && { warnings: allWarnings }) };
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
  const lifecycle = rulingCtx.lifecycleById.get(id);
  const extras = {
    ...(lifecycle !== undefined && { lifecycle }),
    reasons: classifyLifecycle(ruling).reasons,
    proposalsAgainst: proposalsAgainst(rulings, id).map((p) => p.id),
  };
  return { output: formatRuling(ruling, ctx.format, resolution, extras), ...(warnings.length > 0 && { warnings }) };
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

export interface RulingCreateInput extends NarrativeArgs {
  text: string;
  attribution: string;
  date: string;
  scopeTags: string[];
}

/** Refuses an attribution outside RULING_ATTRIBUTIONS and returns the caller identity; runs before any lock. */
export function rulingCreatePreflight(attribution: string, clientTaskId: string | undefined): OwnerTaskLike {
  if (!RULING_ATTRIBUTIONS.includes(attribution as RulingAttribution)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown attribution "${attribution}": must be one of ${RULING_ATTRIBUTIONS.join(", ")}`,
    );
  }
  return requireCallerIdentity(clientTaskId);
}

/** The accepted ruling a create records, minted and validated, not written. Caller holds the lock. */
function buildAcceptedRuling(input: RulingCreateInput, recordedBy: OwnerTaskLike, config: Config, root: string): Ruling {
  const newId = generateCanonicalId("r");
  assertRulingWritesEnabled(config, root, newId);
  const narrative = narrativeFrom(input);
  const payload = {
    id: newId,
    text: input.text,
    attribution: input.attribution as RulingAttribution,
    recordedBy,
    date: input.date,
    scopeTags: input.scopeTags,
    supersedes: null,
    proposesToSupersede: null,
    ...(narrative && { narrative }),
  };
  // T-522: `create` records an ACCEPTED ruling, so it carries the same
  // acceptance evidence `accept` would write. The recorder's claim of who
  // ruled is the record's own attribution.
  return validateOrThrow({
    ...payload,
    status: "accepted",
    acceptance: makeAcceptance(payload, { attribution: payload.attribution, recordedBy, date: input.date }),
  });
}

/**
 * T-537: a ruling create prepared and checked but NOT written, for a caller
 * that holds `.story/.lock` and commits the ruling in its own transaction (a
 * checkpoint resolved by a ruling commits both at once). Refused when the
 * ruling's file already exists, as the cited create below refuses.
 */
export async function prepareRulingUnlocked(
  input: RulingCreateInput,
  recordedBy: OwnerTaskLike,
  config: Config,
  root: string,
): Promise<{ ruling: Ruling; op: { op: "write"; target: string; content: string } }> {
  const ruling = buildAcceptedRuling(input, recordedBy, config, root);
  const prepared = await prepareRulingWrite(ruling, root);
  if (await pathExists(prepared.target)) {
    throw new CliValidationError("conflict", `Ruling ${ruling.id} already exists; refusing to overwrite it`);
  }
  return { ruling, op: { op: "write", target: prepared.target, content: prepared.content } };
}

export async function handleRulingCreate(
  args: RulingCreateInput & {
    cites?: string[];
    clientTaskId?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const recordedBy = rulingCreatePreflight(args.attribution, args.clientTaskId);
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
    const ruling = buildAcceptedRuling(args, recordedBy, loadResult.state.config, root);

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
    branch?: boolean;
  } & NarrativeArgs,
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

  await withProjectLock(root, { strict: true }, async (loadResult) => {
    const newId = generateCanonicalId("r");
    assertRulingWritesEnabled(loadResult.state.config, root, newId);
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
      // T-522: a proposal never gets an edge through this path; `accept` is
      // the one write that records an edge WITH evidence.
      if (existing.status === "proposed") {
        throw new CliValidationError(
          "invalid_input",
          `Ruling ${existing.id} is a proposal; accept it with \`ruling accept ${existing.id} --revision ${payloadDigest(existing)}\` instead of linking it`,
        );
      }
      const refusal = validateSupersedeCandidate(rulings, existing.id, oldId, { branch: args.branch });
      if (refusal) {
        throw new CliValidationError("invalid_input", `Cannot link ${existing.id} to supersede ${oldId}: ${refusal.detail}`);
      }
      // A legacy record is linked in place, as in 1.15. A 1.16 accepted
      // record's edge is INSIDE its accepted payload (the digest covers
      // `proposesToSupersede`), so linking it re-records the acceptance for
      // the new payload: same claimed attribution as the record itself, the
      // caller as recorder. This is the same footing as create-and-supersede,
      // which also mints acceptance on the caller's word.
      const linked = { ...existing, supersedes: oldId, ...(existing.status !== undefined && { proposesToSupersede: oldId }) };
      const updated = validateOrThrow(
        existing.status === undefined
          ? linked
          : {
              ...linked,
              status: "accepted",
              acceptance: makeAcceptance(linked, {
                attribution: existing.attribution,
                recordedBy: requireCallerIdentity(args.clientTaskId),
                date: existing.acceptance?.date ?? existing.date,
              }),
            },
      );
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
    const refusal = validateSupersedeCandidate(rulings, newId, oldId, { branch: args.branch });
    if (refusal) {
      throw new CliValidationError("invalid_input", `Cannot supersede ${oldId}: ${refusal.detail}`);
    }
    const narrative = narrativeFrom(args);
    const payload = {
      id: newId,
      text: args.text,
      attribution: args.attribution as RulingAttribution,
      recordedBy,
      date: args.date,
      scopeTags: args.scopeTags ?? [],
      supersedes: oldId,
      proposesToSupersede: oldId,
      ...(narrative && { narrative }),
    };
    const candidate = validateOrThrow({
      ...payload,
      status: "accepted",
      acceptance: makeAcceptance(payload, { attribution: payload.attribution, recordedBy, date: args.date }),
    });
    await writeRulingUnlocked(candidate, root, { createOnly: true });
    result = { ruling: candidate, noop: false };
  });

  if (!result) throw new Error("Ruling supersede did not complete");
  return { output: formatRulingSupersedeResult(result.ruling, result.noop, format) };
}


// --- T-522: proposal lifecycle write handlers ---

/**
 * `ruling propose`: one file, no item writes. A proposal names the ruling it
 * asks to replace in `proposesToSupersede` and the items it is for in
 * `proposedFor`; its own `supersedes` stays null so a 1.15 reader's index,
 * which reads `supersedes` unconditionally, cannot be displaced by it.
 */
export async function handleRulingPropose(
  args: {
    text: string;
    attribution: string;
    date: string;
    scopeTags: string[];
    proposesToSupersede?: string;
    proposedFor?: string[];
    clientTaskId?: string;
  } & NarrativeArgs,
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
  await withProjectLock(root, { strict: true }, async (loadResult) => {
    const newId = generateCanonicalId("r");
    assertRulingWritesEnabled(loadResult.state.config, root, newId);
    const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries } = loadRulingsSafe(root);
    const target = args.proposesToSupersede ?? null;
    if (target !== null) {
      if (scanCompleteness !== "complete" || unavailableIds.size > 0 || hasUnrecoverableEntries) {
        throw new CliValidationError(
          "conflict",
          "Refusing to propose against a ruling: the ruling ledger is currently unverifiable (an unreadable ruling or incomplete scan). Fix the unreadable file(s) first.",
        );
      }
      const existing = rulings.find((r) => r.id === target);
      if (!existing) throw new CliValidationError("not_found", `Ruling ${target} not found`);
      const lc = lifecycleOf(existing, buildSuccessorIndex(rulings));
      if (!isEffectivelyAccepted(lc)) {
        throw new CliValidationError(
          "invalid_input",
          `Cannot propose against ${target}: it is ${lc}, not an accepted ruling${lc === "proposed" ? "; withdraw or accept it first" : ""}`,
        );
      }
    }
    // Trimmed before dedupe and persist: resolveCitedTargets trims when it
    // resolves, and `accept` re-resolves what was PERSISTED.
    const proposedFor = [...new Set((args.proposedFor ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0))];
    if (proposedFor.length > 0) resolveCitedTargets(loadResult.state, proposedFor);
    const narrative = narrativeFrom(args);
    const ruling = validateOrThrow({
      id: newId,
      text: args.text,
      attribution: args.attribution as RulingAttribution,
      recordedBy,
      date: args.date,
      scopeTags: args.scopeTags,
      supersedes: null,
      status: "proposed",
      proposesToSupersede: target,
      proposedFor,
      ...(narrative && { narrative }),
    });
    await writeRulingUnlocked(ruling, root, { createOnly: true });
    created = ruling;
  });
  if (!created) throw new Error("Ruling not proposed");
  return { output: formatRulingProposeResult(created, format) };
}

/**
 * `ruling accept <id> --revision <digest>`: one lock. `validateAcceptCandidate`
 * gates the write; then the proposed-for items gain the citation (set union)
 * and the ruling is rewritten as accepted with the edge copied into
 * `supersedes`, items FIRST and ruling LAST through the same transaction
 * `create --cites` uses, for the same fail-loud reason.
 *
 * Repeat after completion is a noop success ONLY on valid local acceptance
 * state: explicit status accepted, no conflict, no classification violation,
 * and the current digest equals both the recorded acceptance digest and the
 * revision the caller quoted. It performs no writes. Anything else is refused
 * with the classification reason.
 */
export async function handleRulingAccept(
  id: string,
  args: {
    revision: string;
    attribution: string;
    date: string;
    branch?: boolean;
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
  if (!/^[0-9a-f]{64}$/.test(args.revision)) {
    throw new CliValidationError("invalid_input", "--revision must be the 64-hex revision shown by `ruling get`");
  }
  const recordedBy = requireCallerIdentity(args.clientTaskId);
  let result: { ruling: Ruling; noop: boolean } | undefined;

  await withProjectLock(root, { strict: true }, async (loadResult) => {
    assertRulingWritesEnabled(loadResult.state.config, root, id);
    const loaded = loadRulingsSafe(root);
    const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries } = loaded;
    const existing = rulings.find((r) => r.id === id);
    if (!existing) {
      if (unavailableIds.has(id) || scanCompleteness !== "complete") {
        throw new CliValidationError("io_error", `Ruling ${id} cannot be read or the ledger scan is incomplete`);
      }
      throw new CliValidationError("not_found", `Ruling ${id} not found`);
    }
    const ctx = buildCitationResolutionContext(rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries);
    const lifecycle = ctx.lifecycleById.get(id)!;

    // The noop rule, checked before anything else so a retry after a
    // completed accept is safe and writes nothing.
    if (
      existing.status === "accepted"
      && existing.acceptance !== undefined
      && classifyLifecycle(existing).reasons.length === 0
      && lifecycle !== "conflicted"
      && payloadDigest(existing) === existing.acceptance.payloadDigest
      && args.revision === existing.acceptance.payloadDigest
    ) {
      result = { ruling: existing, noop: true };
      return;
    }

    const state = loadResult.state;
    const itemExists = (ref: string): boolean =>
      state.resolveTicketRef(ref).kind === "found" || state.resolveIssueRef(ref).kind === "found";
    const refusal = validateAcceptCandidate(existing, args.revision, ctx, itemExists, { branch: args.branch });
    if (refusal) {
      throw new CliValidationError(
        refusal.code === "revision_mismatch" ? "conflict" : "invalid_input",
        `Cannot accept ${id}: ${refusal.detail}`,
      );
    }

    const accepted = validateOrThrow({
      ...existing,
      status: "accepted",
      supersedes: existing.proposesToSupersede ?? null,
      acceptance: makeAcceptance(existing, { attribution: args.attribution as RulingAttribution, recordedBy, date: args.date }),
    });

    const targets = resolveCitedTargets(state, existing.proposedFor ?? []);
    const itemOps: Array<{ op: "write"; target: string; content: string }> = [];
    for (const target of targets) {
      const current = target.item.citesRulings ?? [];
      if (current.includes(accepted.id)) continue;
      const next = [...current, accepted.id];
      const prepared =
        target.kind === "issue"
          ? await prepareIssueWrite({ ...target.item, citesRulings: next }, root)
          : await prepareTicketWrite({ ...target.item, citesRulings: next }, root);
      itemOps.push({ op: "write", target: prepared.target, content: prepared.content });
    }
    const rulingPrepared = await prepareRulingWrite(accepted, root);
    try {
      await runTransactionUnlocked(root, [
        ...itemOps,
        { op: "write", target: rulingPrepared.target, content: rulingPrepared.content },
      ]);
    } catch (err) {
      if (err instanceof TransactionRecoveryPendingError) {
        throw new CliValidationError(
          "io_error",
          `Ruling ${accepted.id}: the accept had already begun and forward recovery is pending. `
            + `Do NOT re-run with different arguments; run \`storybloq ruling get ${accepted.id}\` and \`storybloq validate\` to see what landed. `
            + `A repeat \`ruling accept ${accepted.id} --revision ${args.revision}\` after recovery is a safe no-op. `
            + `Underlying failure: ${err.message}`,
        );
      }
      throw err;
    }
    result = { ruling: accepted, noop: false };
  });

  if (!result) throw new Error("Ruling accept did not complete");
  return { output: formatRulingAcceptResult(result.ruling, result.noop, format) };
}

/** `ruling withdraw <id> [--reason]`: proposed records only. */
export async function handleRulingWithdraw(
  id: string,
  args: { reason?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const recordedBy = requireCallerIdentity(args.clientTaskId);
  let withdrawn: Ruling | undefined;
  await withProjectLock(root, { strict: true }, async (loadResult) => {
    assertRulingWritesEnabled(loadResult.state.config, root, id);
    const { rulings, unavailableIds, scanCompleteness, lifecycleById } = loadRulingsSafe(root);
    const existing = rulings.find((r) => r.id === id);
    if (!existing) {
      if (unavailableIds.has(id) || scanCompleteness !== "complete") {
        throw new CliValidationError("io_error", `Ruling ${id} cannot be read or the ledger scan is incomplete`);
      }
      throw new CliValidationError("not_found", `Ruling ${id} not found`);
    }
    const lc = lifecycleById.get(id);
    if (lc !== "proposed") {
      throw new CliValidationError("invalid_input", `Cannot withdraw ${id}: it is ${lc}, not a proposal. Withdrawal never revokes an accepted ruling; supersede it instead.`);
    }
    withdrawn = validateOrThrow({
      ...existing,
      status: "withdrawn",
      withdrawal: { recordedBy, createdAt: new Date().toISOString(), ...(args.reason && { reason: args.reason }) },
    });
    await writeRulingUnlocked(withdrawn, root);
  });
  if (!withdrawn) throw new Error("Ruling withdraw did not complete");
  return { output: formatRulingWithdrawResult(withdrawn, format) };
}
