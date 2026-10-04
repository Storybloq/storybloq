/**
 * Consolidated yargs command registration for the CLI.
 *
 * Each register*Command function wires up yargs command definitions with
 * the corresponding handler from the commands/ directory. This file imports
 * from run.ts (EPIPE listener) and is therefore CLI-only -- MCP must never
 * import this module.
 */
import type { Argv } from "yargs";
import type { CodexReviewKind } from "./commands/codex-review.js";
import type { SetupClient } from "./commands/setup-skill.js";
import { runReadCommand, runReadCommandWithRoot, runDeleteCommand, writeOutput, outputFormatOf, applyHandlerWarnings, runBoardWrite, type BoardWriteArgv } from "./run.js";
import {
  addFormatOption,
  addCommitOption,
  parseOutputFormat,
  parseTicketId,
  parseIssueId,
  parseNoteId,
  parseLessonId,
  normalizeTags,
  readStdinContent,
  resolveCliNodeRoot,
  CliValidationError,
} from "./helpers.js";
import { arrayOption, arrayOptions, arrayPositional } from "./array-options.js";
import {
  handleCapabilityList,
  handleCapabilityGet,
  handleCapabilityMatch,
  handleCapabilityAdd,
  handleCapabilityUpdate,
  handleCapabilityCheck,
  handleCapabilityDefer,
  handleCapabilityRestore,
  type CapabilityWriteInput,
} from "./commands/capability.js";
import {
  handleTermList,
  handleTermGet,
  handleTermMatch,
  handleTermCheck,
  handleTermAdd,
  handleTermUpdate,
  handleTermRemove,
  handleTermDefer,
  handleTermRestore,
  type TermWriteInput,
} from "./commands/term.js";
import { handleBrief, handleBriefRebase } from "./commands/brief.js";
import { handleLedgerRestore } from "./commands/ledger.js";

// Shared comma/empty/trim/emptyAfterSplit combinations. See array-options.ts for
// what each axis means and ISS-886 for why they are declared per registration.
/** Newly comma-enabled list of atomic values. */
const SPLIT_LIST = {
  comma: "split",
  empty: "drop",
  trim: "segments",
  emptyAfterSplit: "reject",
} as const;
/** Already split commas before ISS-886: trims every value and clears on a lone separator. */
const LEGACY_SPLIT_LIST = {
  comma: "split",
  empty: "drop",
  trim: "always",
  emptyAfterSplit: "drop",
} as const;
/** Payload value where a comma is legal; blank entries were already dropped. */
const LITERAL_DROP_BLANK = { comma: "literal", empty: "drop", trim: "never" } as const;
/** Payload value where a comma is legal and a blank must still reach validation. */
const LITERAL_KEEP_BLANK = { comma: "literal", empty: "preserve", trim: "never" } as const;
import { parseMetadataValue } from "./commands/metadata.js";
import { formatError, formatLedgerIntegrity, noProjectFoundOutput, ExitCode } from "../core/output-formatter.js";
import { discoverIntegrityRoot, scanLedgerIntegrity } from "../core/ledger-integrity.js";
import type { IssueSourceRefInput } from "../models/issue.js";

// Handler imports -- read handlers
import { handleStatus } from "./commands/status.js";
import { handleValidateWithSourceRefs } from "./commands/validate.js";
import { handleRepair, computeRepairs } from "./commands/repair.js";
import { handleReconcile } from "./commands/reconcile.js";
import { handleTeamDoctor } from "./commands/team-doctor.js";
import {
  handleHandoverList,
  handleHandoverLatest,
  handleHandoverGet,
  handleHandoverCreate,
  handleHandoverTemplate,
} from "./commands/handover.js";
import { handleBlockerList, handleBlockerAdd, handleBlockerClear } from "./commands/blocker.js";
import {
  handleTicketList,
  handleTicketGet,
  handleTicketNext,
  handleTicketBlocked,
  handleTicketCreate,
  handleTicketUpdate,
  handleTicketMetaGet,
  handleTicketMetaSet,
  handleTicketMetaUnset,
  handleTicketDelete,
  handleTicketUnclaim,
  handleTicketStart,
} from "./commands/ticket.js";
import {
  handleIssueList,
  handleIssueGet,
  handleIssueCreate,
  handleIssueUpdate,
  handleIssueMetaGet,
  handleIssueMetaSet,
  handleIssueMetaUnset,
  handleIssueDelete,
} from "./commands/issue.js";
import {
  handleNoteList,
  handleNoteGet,
  handleNoteCreate,
  handleNoteUpdate,
  handleNoteDelete,
} from "./commands/note.js";
import {
  handleArrangementList,
  handleArrangementGet,
  handleArrangementCreate,
  handleArrangementUpdate,
  handleArrangementCompact,
  handleArrangementRotate,
  handleArrangementRebind,
} from "./commands/arrangement.js";
import { ARRANGEMENT_LIFECYCLE, ARRANGEMENT_ROLES, type ArrangementParty } from "../models/arrangement.js";
import { handleDuetCoordinate, parseDuetOperation } from "./commands/duet.js";
import {
  handleRulingList,
  handleRulingGet,
  handleRulingCreate,
  handleRulingSupersede,
  handleRulingPropose,
  handleRulingAccept,
  handleRulingWithdraw,
  RULING_LIFECYCLES,
  type NarrativeArgs,
} from "./commands/ruling.js";
import { RULING_ATTRIBUTIONS } from "../models/ruling.js";
import type { OutputFormat as RulingOutputFormat } from "../models/types.js";
import type { CommandResult as RulingCommandResult } from "./types.js";
import { handleLandings } from "./commands/landings.js";
import {
  handleGateAckGet,
  handleGateAckList,
  handleGateAckCreate,
  handleGateAckContest,
} from "./commands/gate-ack.js";
import {
  handleEarmarkGet,
  handleEarmarkReserve,
  handleEarmarkAssign,
  handleEarmarkRelease,
} from "./commands/earmark.js";
import { EARMARK_ROLES } from "../models/types.js";
import {
  handleLessonList,
  handleLessonGet,
  handleLessonDigest,
  handleLessonCreate,
  handleLessonUpdate,
  handleLessonReinforce,
  handleLessonDelete,
  LESSON_STATUSES,
  LESSON_SOURCES,
} from "./commands/lesson.js";
import { handleRecommend } from "./commands/recommend.js";
import { handleDispatchRecommend, handleDispatch } from "./commands/dispatch.js";
import {
  handleNodeAdd,
  handleNodeLink,
  resolveOrchestratorArg,
  handleNodeRemove,
  handleNodeUpdate,
  handleNodeList,
} from "./commands/node.js";
import {
  handlePhaseList,
  handlePhaseCurrent,
  handlePhaseTickets,
  handlePhaseCreate,
  handlePhaseRename,
  handlePhaseMove,
  handlePhaseDelete,
} from "./commands/phase.js";

// Re-export init's register (init has no handler separation)
export { registerInitCommand } from "./commands/init.js";
export { registerBusCommand } from "./commands/bus.js";

// New T-084 handler imports
import { handleRecap } from "./commands/recap.js";
import { handleReviewStats } from "./commands/review-stats.js";
import { handleExport } from "./commands/export.js";
import { handleSnapshot } from "./commands/snapshot.js";

// Reference command
import { handleReference } from "./commands/reference.js";

// Selftest command
import { handleSelftest } from "./commands/selftest.js";

function parseIssueSourceRefs(values: string[] | undefined): IssueSourceRefInput[] | undefined {
  if (!values) return undefined;
  return values.map((value, index) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      return parsed as IssueSourceRefInput;
    } catch (err) {
      throw new CliValidationError(
        "invalid_input",
        `Invalid --source-ref value ${index + 1}: ${(err as Error).message}`,
      );
    }
  });
}

function addNodeOption<T>(y: Argv<T>): Argv<T & { node: string | undefined }> {
  return y.option("node", {
    type: "string",
    describe: 'Node name (orchestrator only). Operates on that node\'s .story/ instead of the orchestrator\'s. Pass "." for the orchestrator\'s own board.',
  }) as Argv<T & { node: string | undefined }>;
}

function resolveRootWithNode(
  orchRoot: string,
  nodeName: string | undefined,
  requireWrite: boolean,
  format: string,
): { ok: true; root: string } | { ok: false; output: string } {
  if (!nodeName) return { ok: true, root: orchRoot };
  const resolved = resolveCliNodeRoot(orchRoot, nodeName, requireWrite);
  if (!resolved.ok) {
    return { ok: false, output: formatError(resolved.code, resolved.error, format) };
  }
  return { ok: true, root: resolved.root };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function registerStatusCommand(yargs: Argv): Argv {
  return yargs.command(
    "status",
    "Project summary",
    (y) =>
      addFormatOption(y)
        .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" })
        .option("compact", {
          type: "boolean",
          default: false,
          describe: "T-320: reduced JSON payload (JSON only; ignores --format)",
        }),
    async (argv) => {
      const compact = argv.compact as boolean | undefined;
      // T-320: compact is JSON regardless of --format, and that has to be
      // decided HERE, before runReadCommand -- its usage-advisory/token-
      // pressure pushes (emitCliBanner) append Markdown prose to stdout
      // whenever they fire, which corrupts a compact body if format is
      // still "md" at that point.
      const format = compact ? "json" : parseOutputFormat(argv.format);
      const clientTaskId = argv["client-task-id"] as string | undefined;
      // T-501: status is the /story priming call and the only CLI surface
      // that shows (and consumes) the usage-cost advisory.
      let statusRoot: string | null = null;
      await runReadCommand(format, (ctx) => {
        statusRoot = ctx.root;
        return handleStatus(ctx, clientTaskId, { compact });
      }, { usageAdvisory: true });
      // T-528: the CLI status refreshes the decisions projection (structural,
      // 3 s). The MCP status tool stays read-only: it never reaches this.
      if (statusRoot !== null) await (await import("./commands/projection.js")).refreshProjectionAfterWrite(statusRoot);
    },
  );
}

// ---------------------------------------------------------------------------
// projection (T-528)
// ---------------------------------------------------------------------------

export function registerProjectionCommand(yargs: Argv): Argv {
  return yargs.command(
    "projection",
    "The decisions projection the Mac app reads (.story/cache/decisions-projection.json)",
    (y) =>
      y
        .command(
          "write",
          "Regenerate the decisions projection, with a full freshness check",
          (y: Argv) => addCommitOption(((y2) => addFormatOption(y2))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const result = await runBoardWrite(argv, format, async () => (await import("./commands/projection.js")).handleProjectionWrite(format, root));
            writeOutput(result.output, format);
            process.exitCode = result.exitCode ?? ExitCode.OK;
          },
        )
        .demandCommand(1, "Specify a subcommand: write")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export function registerValidateCommand(yargs: Argv): Argv {
  return yargs.command(
    "validate",
    "Reference integrity + schema checks",
    (y) => addFormatOption(y.option("integrity-only", {
      type: "boolean",
      default: false,
      describe: "Scan JSON and known schemas without loading project state",
    })),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const discovered = (
        await import("../core/project-root-discovery.js")
      ).discoverProjectRoot();
      const root = discovered ?? await discoverIntegrityRoot();
      if (!root) {
        writeOutput(formatError("not_found", "No .story/ project found.", format), format);
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }

      const integrityOnly = argv["integrity-only"] as boolean;
      const integrity = await scanLedgerIntegrity(root, {
        includeAuxiliary: integrityOnly,
      });
      if (integrityOnly || !integrity.valid) {
        writeOutput(formatLedgerIntegrity(integrity, format), format);
        process.exitCode = integrity.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR;
        return;
      }

      await runReadCommandWithRoot(format, root, handleValidateWithSourceRefs);
    },
  );
}

export function registerRepairCommand(yargs: Argv): Argv {
  return yargs.command(
    "repair",
    "Fix stale references in .story/ data",
    (y) => y
      .option("dry-run", { type: "boolean", default: false, describe: "Show what would be fixed without writing" })
      .option("canonicalize-refs", { type: "boolean", default: false, describe: "Rewrite display-ID refs to canonical form" }),
    async (argv) => {
      const dryRun = argv["dry-run"] as boolean;
      const canonicalizeRefs = argv["canonicalize-refs"] as boolean;
      if (dryRun) {
        await runReadCommand("md", (ctx) => handleRepair(ctx, true));
      } else {
        // Write mode: load, compute, apply minimal patches atomically (ISS-738:
        // patches target the raw on-disk JSON, never loader-hydrated entities).
        const { withProjectLock } = await import("../core/project-loader.js");
        const { applyRepairPatches } = await import("./commands/repair.js");
        const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
        await withProjectLock(root, { strict: false }, async ({ state, warnings }) => {
          const result = computeRepairs(state, warnings, { canonicalizeRefs });
          if (result.error) {
            writeOutput(result.error, "md");
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          if (result.fixes.length === 0) {
            writeOutput("No stale references found. Project is clean.", "md");
            return;
          }
          await applyRepairPatches(root, result.patches);
          const lines = [`Fixed ${result.fixes.length} stale reference(s):`, ""];
          for (const fix of result.fixes) {
            lines.push(`- ${fix.entity}.${fix.field}: ${fix.description}`);
          }
          writeOutput(lines.join("\n"), "md");
        });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

export function registerReconcileCommand(yargs: Argv): Argv {
  return yargs.command(
    "reconcile",
    "Detect and fix duplicate displayIds across all entity types",
    (y) =>
      addFormatOption(y
        .option("dry-run", { type: "boolean", default: false, describe: "Show what would change without writing" })
        .option("ci", { type: "boolean", default: false, describe: "Exit non-zero if duplicates found, no mutations" })
        .option("rebalance-ranks", { type: "boolean", default: false, describe: "Also rebalance fractional ranks" })),
    async (argv) => {
      const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
      const result = await handleReconcile(root, {
        dryRun: argv["dry-run"] as boolean,
        ci: argv.ci as boolean,
        rebalanceRanks: argv["rebalance-ranks"] as boolean,
        format: (argv.format as "md" | "json") ?? "md",
      });
      writeOutput(result.output, outputFormatOf(argv.format));
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// conflicts + resolve
// ---------------------------------------------------------------------------

export function registerConflictsCommand(yargs: Argv): Argv {
  return yargs.command(
    "conflicts",
    "View merge conflicts in .story/ items",
    (y) =>
      y
        .command(
          "list",
          "List all items with unresolved conflicts",
          (y2) => addFormatOption(y2, 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
          async (argv) => {
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
            const { handleConflictsList } = await import("./commands/conflicts.js");
            const result = await handleConflictsList(root, (argv.format as "md" | "json") ?? "md");
            writeOutput(result.output, outputFormatOf(argv.format));
          },
        )
        .command(
          "show <id>",
          "Show field-level conflict detail for an item",
          (y2) =>
            addFormatOption(y2
              .positional("id", { type: "string", demandOption: true, describe: "Entity ID" }), 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
          async (argv) => {
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
            const { handleConflictsShow } = await import("./commands/conflicts.js");
            const result = await handleConflictsShow(argv.id as string, root, (argv.format as "md" | "json") ?? "md");
            writeOutput(result.output, outputFormatOf(argv.format));
            if (result.exitCode) process.exitCode = result.exitCode;
          },
        )
        .demandCommand(1, ""),
    () => {},
  );
}

export function registerResolveCommand(yargs: Argv): Argv {
  return yargs.command(
    // T-529: the positional is `target`, not `id`, because `--id` names a
    // catalog entry and yargs gives a positional and an option of one name a
    // single key (the positional wins and the flag is lost).
    "resolve <target>",
    "Resolve merge conflicts on a .story/ item",
    (y) =>
      addFormatOption(arrayOptions(y
        .positional("target", { type: "string", demandOption: true, describe: "Entity ID, config, roadmap, capabilities or glossary" })
        .option("field", { type: "string", describe: "Resolve a specific field" })
        .option("use", { type: "string", choices: ["ours", "theirs"], describe: "Pick a side" })
        .option("value", { type: "string", describe: "Custom value (JSON)" })
        .option("id", { type: "string", describe: "Catalog only: the entry whose records to resolve" })
        .option("group", { type: "string", describe: "Catalog only: resolve an entry's coupled group (with --id)" })
        .option("invariant", { type: "number", describe: "Catalog only: the invariant conflict to resolve, numbered as conflicts show prints it" })
        .option("keep", { type: "string", describe: "With --invariant: keep this term, delete the other claimants" }), {
        rename: { comma: "literal", empty: "preserve", trim: "never", describe: "With --invariant: <id> <new value>" },
        "drop-alias": { comma: "literal", empty: "preserve", trim: "never", describe: "With --invariant: <id> <alias>" },
      }), 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
    async (argv) => {
      const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
      if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
      try {
        const { handleResolve } = await import("./commands/conflicts.js");
        let parsedValue: unknown;
        if (argv.value !== undefined) {
          try { parsedValue = JSON.parse(argv.value as string); } catch { parsedValue = argv.value; }
        }
        const result = await handleResolve(argv.target as string, root, {
          field: argv.field as string | undefined,
          use: argv.use as "ours" | "theirs" | undefined,
          value: parsedValue,
          entityId: argv.id,
          group: argv.group,
          invariant: argv.invariant as number | undefined,
          rename: argv.rename as string[] | undefined,
          dropAlias: argv["drop-alias"] as string[] | undefined,
          keep: argv.keep,
          format: (argv.format as "md" | "json") ?? "md",
        });
        writeOutput(result.output, outputFormatOf(argv.format));
        if (result.exitCode) process.exitCode = result.exitCode;
      } catch (err: unknown) {
        // ISS-910: same rule the gc and team-reserve adapters already follow
        // (ISS-805 R3) -- a post-validation handler failure still honors
        // --format json, emitting one parseable { ok:false, error } object
        // rather than prose an automated caller cannot read.
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(
          argv.format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message,
          outputFormatOf(argv.format),
        );
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

export function registerGcCommand(yargs: Argv): Argv {
  return yargs.command(
    "gc",
    "Remove tombstoned files past retention period",
    (y) =>
      addFormatOption(y
        .option("apply", {
          type: "boolean",
          default: false,
          describe: "Actually delete files (default is dry-run)",
        })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Remove referenced tombstones too",
        })
        .option("retention-days", {
          type: "number",
          default: 30,
          describe: "Retention period in days",
        }), 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
    async (argv) => {
      const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
      if (!root) {
        writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format));
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      const gcFormat = (argv.format as "md" | "json") ?? "md";
      try {
        const { handleGc } = await import("./commands/gc.js");
        const result = await handleGc(root, {
          apply: argv.apply as boolean,
          force: argv.force as boolean,
          retentionDays: argv["retention-days"] as number,
          format: gcFormat,
        });
        writeOutput(result.output, gcFormat);
        if (result.exitCode) process.exitCode = result.exitCode;
      } catch (err: unknown) {
        // ISS-805 R3: a post-validation handler failure must still honor
        // --format json, emitting one parseable { ok:false, error } object.
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(
          gcFormat === "json"
            ? JSON.stringify({ ok: false, error: message }, null, 2)
            : message,
          gcFormat,
        );
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// merge-driver
// ---------------------------------------------------------------------------

export function registerMergeDriverCommand(yargs: Argv): Argv {
  return yargs.command(
    "merge-driver [ancestor] [ours] [theirs] [pathname]",
    "Git merge driver for .story/ JSON files",
    (y) =>
      y
        .positional("ancestor", { type: "string", describe: "Base (common ancestor) file path" })
        .positional("ours", { type: "string", describe: "Our (HEAD) file path" })
        .positional("theirs", { type: "string", describe: "Their (incoming) file path" })
        .positional("pathname", { type: "string", describe: "Logical file path (%P)" })
        .option("protocol", { type: "number", describe: "Driver protocol the registration requires (T-537: 4)" })
        .option("capabilities", { type: "boolean", default: false, describe: "Print the driver's capabilities as JSON and exit" }),
    async (argv) => {
      const { handleMergeDriver, mergeDriverCapabilities, MERGE_DRIVER_PROTOCOL } = await import("./commands/merge-driver.js");
      const protocol = argv.protocol as number | undefined;
      if (argv.capabilities) {
        if (protocol !== undefined && protocol !== MERGE_DRIVER_PROTOCOL) {
          process.stderr.write(`storybloq merge-driver: protocol ${protocol} is not supported by this build (supports ${MERGE_DRIVER_PROTOCOL})\n`);
          process.exitCode = 2;
          return;
        }
        process.stdout.write(JSON.stringify(mergeDriverCapabilities()) + "\n");
        process.exitCode = 0;
        return;
      }
      const [ancestor, ours, theirs, pathname] = [argv.ancestor, argv.ours, argv.theirs, argv.pathname] as (string | undefined)[];
      if (ancestor === undefined || ours === undefined || theirs === undefined || pathname === undefined) {
        process.stderr.write("storybloq merge-driver: expected <ancestor> <ours> <theirs> <pathname>\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await handleMergeDriver(ancestor, ours, theirs, pathname, protocol);
    },
  );
}

// ---------------------------------------------------------------------------
// team
// ---------------------------------------------------------------------------

export function registerTeamCommand(yargs: Argv): Argv {
  return yargs.command(
    "team",
    "Team-mode commands",
    (y) =>
      y.command(
        "doctor",
        "Run team health checks on the project",
        (y2) =>
          addFormatOption(y2
            .option("ci", { type: "boolean", default: false, describe: "Exit non-zero on error-level findings" })),
        async (argv) => {
          const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
          const result = await handleTeamDoctor(root, {
            ci: argv.ci as boolean,
            format: (argv.format as "md" | "json") ?? "md",
          });
          writeOutput(result.output, outputFormatOf(argv.format));
          if (result.exitCode !== undefined && result.exitCode !== 0) {
            process.exitCode = result.exitCode;
          }
        },
      )
      .command(
        "reserve <type>",
        "Reserve display IDs via remote git refs",
        (y2) =>
          addFormatOption(y2
            .positional("type", { type: "string", demandOption: true, choices: ["tickets", "issues", "notes", "lessons"], describe: "Entity type" })
            .option("count", { type: "number", default: 1, describe: "Number of IDs to reserve (1-100)" }), 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
        async (argv) => {
          const reserveFormat = (argv.format as "md" | "json") ?? "md";
          // ISS-805 R1: validate --count BEFORE project discovery so the JSON
          // error envelope wins even outside a project. The shared helper is
          // also used inside handleReserve, so the check is not duplicated ad hoc.
          const { handleReserve, validateReserveCount, formatReserveCountError } = await import("./commands/reserve.js");
          const countError = validateReserveCount(argv.count as number);
          if (countError) {
            const res = formatReserveCountError(countError, reserveFormat);
            writeOutput(res.output, reserveFormat);
            if (res.exitCode) process.exitCode = res.exitCode;
            return;
          }
          const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
          if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
          try {
            const result = await handleReserve(root, argv.type as "tickets" | "issues" | "notes" | "lessons", argv.count as number, reserveFormat);
            writeOutput(result.output, reserveFormat);
            if (result.exitCode) process.exitCode = result.exitCode;
          } catch (err: unknown) {
            // ISS-805 R3: a post-validation handler failure must still honor
            // --format json, emitting one parseable { ok:false, error } object.
            const message = err instanceof Error ? err.message : String(err);
            writeOutput(
              reserveFormat === "json"
                ? JSON.stringify({ ok: false, error: message }, null, 2)
                : message,
              reserveFormat,
            );
            process.exitCode = ExitCode.USER_ERROR;
          }
        },
      )
      .command(
        "init",
        "Enable team mode on this project",
        (y2) =>
          addFormatOption(y2
            .option("claim-staleness-hours", { type: "number", describe: "Hours before a claim is considered stale (default 48)" })
            .option("id-allocator", { type: "string", choices: ["local", "git-refs"], describe: "ID allocation strategy: local (default) needs no remote but divergent branches can mint duplicate display ids (run `storybloq reconcile` after merges); git-refs reserves ids via remote refs, preventing collisions at the source" }), "its own top-level result object with no envelope"),
        async (argv) => {
          const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
          if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
          const { handleTeamInit } = await import("./commands/team-init.js");
          const result = await handleTeamInit(root, {
            claimStalenessHours: argv["claim-staleness-hours"] as number | undefined,
            idAllocator: argv["id-allocator"] as "local" | "git-refs" | undefined,
            format: (argv.format as "md" | "json") ?? "md",
          });
          writeOutput(result.output, outputFormatOf(argv.format));
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        },
      )
      .command(
        "setup",
        "Install git merge driver and .gitattributes for team mode",
        (y2) => addFormatOption(y2, "its own top-level result object with no envelope"),
        async (argv) => {
          const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
          if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
          const { handleTeamSetup } = await import("./commands/team-setup.js");
          const result = await handleTeamSetup(root, { format: (argv.format as "md" | "json") ?? "md" });
          writeOutput(result.output, outputFormatOf(argv.format));
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        },
      )
      .command(
        "config",
        "Show or set team configuration",
        (y) =>
          y
            .command(
              "show",
              "Show current team configuration",
              (y2) => addFormatOption(y2),
              async (argv) => {
                const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
                if (!root) { writeOutput(noProjectFoundOutput(argv.format, "envelope"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
                const { handleTeamConfigShow } = await import("./commands/team-config.js");
                const result = handleTeamConfigShow(root, parseOutputFormat(argv.format));
                writeOutput(result.output, outputFormatOf(argv.format));
              },
            )
            .command(
              "set <key> <value>",
              "Set a team configuration value",
              (y2) =>
                addFormatOption(
                  y2
                    .positional("key", { type: "string", demandOption: true, describe: "Config key" })
                    .positional("value", { type: "string", demandOption: true, describe: "Config value (JSON or string)" }),
                ),
              async (argv) => {
                const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
                if (!root) { writeOutput(noProjectFoundOutput(argv.format, "envelope"), outputFormatOf(argv.format)); process.exitCode = ExitCode.USER_ERROR; return; }
                const { handleTeamConfigSet } = await import("./commands/team-config.js");
                const result = await handleTeamConfigSet(root, argv.key as string, argv.value as string, parseOutputFormat(argv.format));
                writeOutput(result.output, outputFormatOf(argv.format));
              },
            )
            .demandCommand(1, "Specify: show or set"),
        () => {},
      )
      .demandCommand(1, ""),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export function registerMigrateCommand(yargs: Argv): Argv {
  return yargs.command(
    "migrate",
    "Migrate config schema to latest version",
    (y) =>
      addFormatOption(y
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Show proposed changes without writing",
        })),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const dryRun = argv["dry-run"] as boolean;
      const { handleMigrate } = await import("./commands/migrate.js");
      const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
      if (!root) {
        writeOutput(formatError("not_found", "No .story/ project found.", format), format);
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      const result = await handleMigrate(root, format, { dryRun });
      writeOutput(result.output, format);
      if (result.errorCode) {
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// handover
// ---------------------------------------------------------------------------

export function registerHandoverCommand(yargs: Argv): Argv {
  return yargs.command(
    "handover",
    "Handover operations",
    (y) =>
      y
        .command(
          "list",
          "List handover filenames (newest first)",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handleHandoverList);
          },
        )
        .command(
          "latest",
          "Content of most recent handover(s)",
          (y2) =>
            addFormatOption(
              y2
                .option("count", {
                  type: "number",
                  default: 1,
                  describe: "Number of recent handovers to return (default: 1)",
                })
                .option("brief", {
                  type: "boolean",
                  describe:
                    "T-320: structured record digest (continuation/blocked/owner-gated/carried plus trajectory) instead of full bodies",
                })
                .option("priming", {
                  type: "boolean",
                  describe:
                    "T-320/T-497: full body at or under 12,000 bytes per handover, else the same structured digest as --brief",
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const brief = argv.brief as boolean | undefined;
            const priming = argv.priming as boolean | undefined;
            let count = Math.max(1, Math.floor(argv.count as number));
            // T-320: capped at 10 ONLY for brief/priming, matching
            // storybloq_handover_latest's existing MCP schema (z.number()
            // .max(10)) -- the cross-handover budget's H=14,200 is only sized
            // for a window this small. The plain default path (neither flag)
            // is untouched: it never had a count cap and must stay that way.
            if (brief || priming) count = Math.min(10, count);
            await runReadCommand(format, (ctx) =>
              handleHandoverLatest(ctx, count, { brief, priming }),
            );
          },
        )
        .command(
          "get <filename>",
          "Content of a specific handover",
          (y2) =>
            addFormatOption(
              y2.positional("filename", {
                type: "string",
                demandOption: true,
                describe: "Handover filename (e.g. 2026-03-19-session.md)",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const filename = argv.filename as string;
            await runReadCommand(format, (ctx) =>
              handleHandoverGet(filename, ctx),
            );
          },
        )
        .command(
          "create",
          "Create a new handover document",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .option("content", {
                  type: "string",
                  describe: "Handover content (markdown string)",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read content from stdin",
                })
                .option("slug", {
                  type: "string",
                  default: "session",
                  describe: "Slug for filename (e.g. phase5b-wrapup)",
                })
                .conflicts("content", "stdin")
                .check((argv) => {
                  if (!argv.content && !argv.stdin) {
                    throw new Error(
                      "Specify either --content or --stdin",
                    );
                  }
                  return true;
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            let content: string;
            if (argv.stdin) {
              if (process.stdin.isTTY) {
                writeOutput(
                  formatError("invalid_input", "Cannot read from stdin: no pipe detected. Use --content instead.", format),
                  format,
                );
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const chunks: Buffer[] = [];
              for await (const chunk of process.stdin) {
                chunks.push(chunk as Buffer);
              }
              content = Buffer.concat(chunks).toString("utf-8");
            } else {
              content = argv.content as string;
            }

            try {
              const result = await runBoardWrite(argv, format, async () => handleHandoverCreate(
                content,
                argv.slug as string,
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "template",
          "Scaffold a new handover document (category headings, Carried forward, marker)",
          (y2) =>
            addFormatOption(
              y2.option("override", {
                type: "string",
                describe:
                  "Override line body: recommended=<id> worked=<id> because=<text>",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const override = argv.override as string | undefined;
            await runReadCommand(format, (ctx) =>
              handleHandoverTemplate(ctx, { override }),
            );
          },
        )
        .demandCommand(1, "Specify a handover subcommand: list, latest, get, create, template")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// blocker
// ---------------------------------------------------------------------------

export function registerBlockerCommand(yargs: Argv): Argv {
  return yargs.command(
    "blocker",
    "Blocker operations",
    (y) =>
      y
        .command(
          "list",
          "List all blockers",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handleBlockerList);
          },
        )
        .command(
          "add",
          "Add a new blocker",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .option("name", {
                  type: "string",
                  demandOption: true,
                  describe: "Blocker name",
                })
                .option("note", {
                  type: "string",
                  describe: "Optional note",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleBlockerAdd(
                {
                  name: argv.name as string,
                  note: argv.note as string | undefined,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "clear",
          "Clear (resolve) a blocker",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .option("name", {
                  type: "string",
                  demandOption: true,
                  describe: "Blocker name to clear",
                })
                .option("note", {
                  type: "string",
                  describe: "Optional note",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleBlockerClear(
                argv.name as string,
                argv.note as string | undefined,
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(1, "Specify a blocker subcommand: list, add, clear")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// ticket
// ---------------------------------------------------------------------------

export function registerTicketCommand(yargs: Argv): Argv {
  return yargs.command(
    "ticket",
    "Ticket operations",
    (y) =>
      y
        .command(
          "list",
          "List tickets",
          (y2) =>
            addNodeOption(addFormatOption(
              y2
                .option("status", {
                  type: "string",
                  describe: "Filter by status",
                })
                .option("phase", {
                  type: "string",
                  describe: "Filter by phase",
                })
                .option("type", {
                  type: "string",
                  describe: "Filter by type",
                }),
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const nodeName = argv.node as string | undefined;
            if (nodeName) {
              const orchRoot = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
              if (!orchRoot) { writeOutput(formatError("not_found", "No .story/ project found.", format), format); process.exitCode = ExitCode.USER_ERROR; return; }
              const eff = resolveRootWithNode(orchRoot, nodeName, false, format);
              if (!eff.ok) { writeOutput(eff.output, format); process.exitCode = ExitCode.USER_ERROR; return; }
              await runReadCommandWithRoot(format, eff.root, (ctx) =>
                handleTicketList({ status: argv.status as string | undefined, phase: argv.phase as string | undefined, type: argv.type as string | undefined }, ctx),
              );
            } else {
              await runReadCommand(format, (ctx) =>
                handleTicketList({ status: argv.status as string | undefined, phase: argv.phase as string | undefined, type: argv.type as string | undefined }, ctx),
              );
            }
          },
        )
        .command(
          "get <id>",
          "Get ticket details",
          (y2) =>
            addFormatOption(
              y2.positional("id", {
                type: "string",
                demandOption: true,
                describe: "Ticket ID (e.g. T-001)",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            await runReadCommand(format, (ctx) => handleTicketGet(id, ctx));
          },
        )
        .command(
          "next",
          "Suggest next ticket to work on",
          (y2) => addFormatOption(y2).option("count", {
            type: "number",
            default: 1,
            describe: "Number of candidates to suggest (1-10)",
          }),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const raw = Number(argv.count) || 1;
            const count = Math.max(1, Math.min(10, Math.floor(raw)));
            await runReadCommand(format, (ctx) => handleTicketNext(ctx, count));
          },
        )
        .command(
          "blocked",
          "List blocked tickets",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handleTicketBlocked);
          },
        )
        .command(
          "create",
          "Create a new ticket",
          (y: Argv) => addCommitOption(((y2) =>
            addNodeOption(addFormatOption(
              arrayOptions(y2
                .option("title", {
                  type: "string",
                  demandOption: true,
                  describe: "Ticket title",
                })
                .option("type", {
                  type: "string",
                  demandOption: true,
                  describe: "Ticket type",
                })
                .option("phase", {
                  type: "string",
                  describe: "Phase ID (default: the current phase when the project has phases; \"\" leaves it unphased)",
                })
                .option("description", {
                  type: "string",
                  describe: "Ticket description",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read description from stdin",
                })
                .option("parent-ticket", {
                  type: "string",
                  describe: "Parent ticket ID (makes this a sub-ticket)",
                })
                .conflicts("description", "stdin"),
              {
                "blocked-by": { ...SPLIT_LIST, describe: "IDs of blocking tickets" },
                "cites-ruling": { ...SPLIT_LIST, describe: "Ruling IDs this ticket cites (e.g. r-[canonical])" },
              },
            ))))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const orchRoot = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!orchRoot) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, argv.node as string | undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output, format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let description = (argv.description as string | undefined) ?? "";
              if (argv.stdin) {
                description = await readStdinContent();
              }
              const result = await runBoardWrite(argv, format, async () => handleTicketCreate(
                {
                  title: argv.title as string,
                  type: argv.type as string,
                  // ISS-1112: absent means not chosen (defaulted); "" is an explicit unphased choice.
                  phase: argv.phase === "" ? null : (argv.phase as string | undefined),
                  description,
                  blockedBy: (
                    argv["blocked-by"] as string[] | undefined ?? []
                  ),
                  parentTicket:
                    argv["parent-ticket"] === "" ? null : (argv["parent-ticket"] as string | undefined) ?? null,
                  citesRuling: argv["cites-ruling"] as string[] | undefined,
                },
                format,
                eff.root,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update a ticket",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Ticket ID (e.g. T-001)",
                })
                .option("status", {
                  type: "string",
                  describe: "New status",
                })
                .option("title", {
                  type: "string",
                  describe: "New title",
                })
                .option("type", {
                  type: "string",
                  describe: "New type",
                })
                .option("phase", {
                  type: "string",
                  describe: "New phase ID",
                })
                .option("order", {
                  type: "number",
                  describe: "New sort order",
                })
                .option("description", {
                  type: "string",
                  describe: "New description",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read description from stdin",
                })
                .option("parent-ticket", {
                  type: "string",
                  describe: "Parent ticket ID",
                })
                .option("node", {
                  type: "string",
                  describe: "Node name (orchestrator only)",
                })
                .option("force", {
                  type: "boolean",
                  default: false,
                  describe: "Complete a claimed ticket without proving ownership (T-442)",
                })
                .option("clear-cites-rulings", {
                  type: "boolean",
                  describe: "Clear all cited rulings",
                })
                .conflicts("description", "stdin")
                .conflicts("cites-ruling", "clear-cites-rulings"),
              {
                "blocked-by": { ...SPLIT_LIST, describe: "IDs of blocking tickets" },
                "cross-node-blocked-by": {
                  ...LEGACY_SPLIT_LIST,
                  describe: "Cross-node blocking refs (e.g. engine:T-001). Bare flag clears.",
                },
                "cites-ruling": {
                  ...SPLIT_LIST,
                  describe: "Ruling IDs this ticket cites (replaces existing)",
                  requireValue: "Use --clear-cites-rulings to clear.",
                },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const orchRoot = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!orchRoot) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, argv.node as string | undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output, format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let description = argv.description as string | undefined;
              if (argv.stdin) {
                description = await readStdinContent();
              }
              // Splitting and trimming now happen at parse time, but the presence
              // conversion must stay: handleTicketUpdate treats null as "remove the
              // field" while an empty array would persist crossNodeBlockedBy: [].
              const rawCrossNode = argv["cross-node-blocked-by"] as string[] | undefined;
              const crossNodeBlockedBy: string[] | null | undefined =
                rawCrossNode === undefined
                  ? undefined
                  : rawCrossNode.length > 0 ? rawCrossNode : null;
              const result = await runBoardWrite(argv, format, async () => handleTicketUpdate(
                id,
                {
                  status: argv.status as string | undefined,
                  title: argv.title as string | undefined,
                  type: argv.type as string | undefined,
                  phase: argv.phase === "" ? null : argv.phase as string | undefined,
                  order: argv.order as number | undefined,
                  description,
                  blockedBy: argv["blocked-by"] as string[] | undefined,
                  crossNodeBlockedBy,
                  parentTicket: argv["parent-ticket"] === "" ? null : argv["parent-ticket"] as string | undefined,
                  citesRuling: argv["cites-ruling"] as string[] | undefined,
                  clearCitesRulings: argv["clear-cites-rulings"] as boolean | undefined,
                },
                format,
                eff.root,
                argv.force as boolean,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "meta <operation> <id> [path] [value]",
          "Get, set, or unset custom ticket metadata",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("operation", {
                  type: "string",
                  demandOption: true,
                  choices: ["get", "set", "unset"],
                  describe: "Metadata operation",
                })
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Ticket ID (e.g. T-001)",
                })
                .positional("path", {
                  type: "string",
                  describe: "Custom metadata path, using dot notation for nested values",
                })
                .positional("value", {
                  type: "string",
                  describe: "JSON value for set; wrap strings in quotes",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const operation = argv.operation as string;

            if (operation === "get") {
              await runReadCommand(format, (ctx) =>
                handleTicketMetaGet(id, argv.path as string | undefined, ctx),
              );
              return;
            }

            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            try {
              const path = argv.path as string | undefined;
              if (!path) {
                throw new CliValidationError("invalid_input", "Metadata path is required");
              }
              const rawValue = argv.value as string | undefined;
              if (operation === "set" && rawValue === undefined) {
                throw new CliValidationError("invalid_input", "Metadata value is required for set");
              }
              const result = operation === "set"
                ? await runBoardWrite(argv, format, async () => handleTicketMetaSet(
                  id,
                  path,
                  parseMetadataValue(rawValue!),
                  format,
                  root,
                ))
                : await runBoardWrite(argv, format, async () => handleTicketMetaUnset(id, path, format, root));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "move <id>",
          "Move a ticket relative to another (fractional rank)",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Ticket ID to move" })
                .option("after", { type: "string", describe: "Place after this ticket" })
                .option("before", { type: "string", describe: "Place before this ticket" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const { handleTicketMove } = await import("./commands/move.js");
              const result = await runBoardWrite(argv, format, async () => handleTicketMove(id, root, {
                after: argv.after as string | undefined,
                before: argv.before as string | undefined,
                format: format as "md" | "json",
              }));
              writeOutput(result.output, format);
              if (result.exitCode) process.exitCode = result.exitCode;
            } catch (err: unknown) {
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a ticket",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Ticket ID (e.g. T-001)",
                })
                .option("force", {
                  type: "boolean",
                  default: false,
                  describe: "Force delete even with integrity issues",
                })
                .option("hard", {
                  type: "boolean",
                  default: false,
                  describe: "Force physical removal (skip soft delete in team mode)",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const force = argv.force as boolean;
            const hard = argv.hard as boolean;
            const { resolveAndNormalizeTicketRef } = await import("../core/ref-normalization.js");
            await runDeleteCommand(argv, format, force, async (ctx) => {
              const resolvedId = resolveAndNormalizeTicketRef(ctx.state, id);
              const ticket = ctx.state.ticketByID(resolvedId);
              return handleTicketDelete(resolvedId, force, format, ctx.root, hard, ticket?.displayId ?? resolvedId);
            });
          },
        )
        .command(
          "unclaim <id>",
          "Remove claim from a ticket",
          (y: Argv) => addCommitOption(((y2) => addFormatOption(
            y2.positional("id", { type: "string", demandOption: true, describe: "Ticket ID" }),
          ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const orchRoot = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!orchRoot) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output, format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleTicketUnclaim(id, format, eff.root));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "start <id>",
          "Claim a ticket and set status to inprogress",
          (y: Argv) => addCommitOption(((y2) => addFormatOption(
            y2.positional("id", { type: "string", demandOption: true, describe: "Ticket ID" })
              .option("force", { type: "boolean", default: false, describe: "Take over a teammate's claim without a warning (claims are advisory; start never hard-blocks)" }),
          ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const force = argv.force as boolean | undefined;
            const orchRoot = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!orchRoot) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output, format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleTicketStart(id, format, eff.root, force));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(
          1,
          "Specify a ticket subcommand: list, get, next, blocked, create, update, meta, delete, start, unclaim",
        )
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// issue
// ---------------------------------------------------------------------------

export function registerIssueCommand(yargs: Argv): Argv {
  return yargs.command(
    "issue",
    "Issue operations",
    (y) =>
      y
        .command(
          "list",
          "List issues",
          (y2) =>
            addFormatOption(
              y2
                .option("status", {
                  type: "string",
                  describe: "Filter by status",
                })
                .option("severity", {
                  type: "string",
                  describe: "Filter by severity",
                })
                .option("component", {
                  type: "string",
                  describe: "Filter by component",
                })
                .option("phase", {
                  type: "string",
                  describe: "Filter by phase",
                })
                .option("disposition", {
                  type: "string",
                  describe: "Filter by disposition, or none",
                })
                .option("actionable", {
                  type: "boolean",
                  describe: "Only issues with no non-actionable disposition",
                  conflicts: "non-actionable",
                })
                .option("non-actionable", {
                  type: "boolean",
                  describe: "Only issues with a non-actionable disposition",
                })
                .option("resolution-kind", {
                  type: "string",
                  describe: "Filter by effective resolution kind",
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const actionable = argv.actionable === true ? true : argv["non-actionable"] === true ? false : undefined;
            await runReadCommand(format, (ctx) =>
              handleIssueList(
                {
                  status: argv.status as string | undefined,
                  severity: argv.severity as string | undefined,
                  component: argv.component as string | undefined,
                  phase: argv.phase as string | undefined,
                  disposition: argv.disposition as string | undefined,
                  actionable,
                  resolutionKind: argv["resolution-kind"] as string | undefined,
                },
                ctx,
              ),
            );
          },
        )
        .command(
          "get <id>",
          "Get issue details",
          (y2) =>
            addFormatOption(
              y2.positional("id", {
                type: "string",
                demandOption: true,
                describe: "Issue ID (e.g. ISS-001)",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseIssueId(argv.id as string);
            await runReadCommand(format, (ctx) => handleIssueGet(id, ctx));
          },
        )
        .command(
          "create",
          "Create a new issue",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .option("title", {
                  type: "string",
                  demandOption: true,
                  describe: "Issue title",
                })
                .option("severity", {
                  type: "string",
                  demandOption: true,
                  describe: "Issue severity",
                })
                .option("impact", {
                  type: "string",
                  describe: "Impact description",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read impact from stdin",
                })
                .option("phase", {
                  type: "string",
                  describe: "Phase ID",
                })
                .option("dedupe-key", {
                  type: "string",
                  describe: "Idempotency key for reviewer or automation retries",
                })
                .option("created-by", {
                  type: "string",
                  describe: "Reviewer or agent that created the issue",
                })
                .conflicts("impact", "stdin")
                .check((a) => {
                  if (!a.impact && !a.stdin) {
                    throw new Error("Specify either --impact or --stdin");
                  }
                  return true;
                }),
              {
                components: { ...SPLIT_LIST, describe: "Affected components" },
                "related-tickets": { ...SPLIT_LIST, describe: "Related ticket IDs" },
                location: { ...LITERAL_DROP_BLANK, describe: "File locations" },
                "source-ref": {
                  ...LITERAL_KEEP_BLANK,
                  describe: "Source reference as a JSON object",
                },
                "cites-ruling": { ...SPLIT_LIST, describe: "Ruling IDs this issue cites (e.g. r-[canonical])" },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let impact = (argv.impact as string | undefined) ?? "";
              if (argv.stdin) {
                impact = await readStdinContent();
              }
              const result = await runBoardWrite(argv, format, async () => handleIssueCreate(
                {
                  title: argv.title as string,
                  severity: argv.severity as string,
                  impact,
                  components: (argv.components as string[] | undefined) ?? [],
                  relatedTickets: (argv["related-tickets"] as string[] | undefined) ?? [],
                  location: (argv.location as string[] | undefined) ?? [],
                  sourceRefs: parseIssueSourceRefs(argv["source-ref"] as string[] | undefined),
                  dedupeKey: argv["dedupe-key"] as string | undefined,
                  createdBy: argv["created-by"] as string | undefined,
                  phase: argv.phase === "" ? undefined : (argv.phase as string | undefined),
                  citesRuling: argv["cites-ruling"] as string[] | undefined,
                },
                format,
                root,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update an issue",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Issue ID (e.g. ISS-001)",
                })
                .option("status", {
                  type: "string",
                  describe: "New status",
                })
                .option("title", {
                  type: "string",
                  describe: "New title",
                })
                .option("severity", {
                  type: "string",
                  describe: "New severity",
                })
                .option("impact", {
                  type: "string",
                  describe: "New impact description",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read impact from stdin",
                })
                .option("resolution", {
                  type: "string",
                  describe: "Resolution description",
                })
                .option("order", {
                  type: "number",
                  describe: "New sort order",
                })
                .option("phase", {
                  type: "string",
                  describe: "New phase ID",
                })
                .option("clear-cites-rulings", {
                  type: "boolean",
                  describe: "Clear all cited rulings",
                })
                .conflicts("impact", "stdin")
                .conflicts("cites-ruling", "clear-cites-rulings"),
              {
                components: { ...SPLIT_LIST, describe: "Affected components" },
                "related-tickets": { ...SPLIT_LIST, describe: "Related ticket IDs" },
                location: { ...LITERAL_DROP_BLANK, describe: "File locations" },
                "source-ref": {
                  ...LITERAL_KEEP_BLANK,
                  describe: "Replacement source ref (JSON object)",
                },
                "cites-ruling": {
                  ...SPLIT_LIST,
                  describe: "Ruling IDs this issue cites (replaces existing)",
                  requireValue: "Use --clear-cites-rulings to clear.",
                },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseIssueId(argv.id as string);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let impact = argv.impact as string | undefined;
              if (argv.stdin) {
                impact = await readStdinContent();
              }
              const result = await runBoardWrite(argv, format, async () => handleIssueUpdate(
                id,
                {
                  status: argv.status as string | undefined,
                  title: argv.title as string | undefined,
                  severity: argv.severity as string | undefined,
                  impact,
                  resolution:
                    argv.resolution === ""
                      ? null
                      : (argv.resolution as string | undefined),
                  components: argv.components as string[] | undefined,
                  relatedTickets: argv["related-tickets"] as string[] | undefined,
                  location: argv.location as string[] | undefined,
                  sourceRefs: parseIssueSourceRefs(argv["source-ref"] as string[] | undefined),
                  order: argv.order as number | undefined,
                  phase: argv.phase === "" ? null : argv.phase as string | undefined,
                  citesRuling: argv["cites-ruling"] as string[] | undefined,
                  clearCitesRulings: argv["clear-cites-rulings"] as boolean | undefined,
                },
                format,
                root,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "meta <operation> <id> [path] [value]",
          "Get, set, or unset custom issue metadata",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("operation", {
                  type: "string",
                  demandOption: true,
                  choices: ["get", "set", "unset"],
                  describe: "Metadata operation",
                })
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Issue ID (e.g. ISS-001)",
                })
                .positional("path", {
                  type: "string",
                  describe: "Custom metadata path, using dot notation for nested values",
                })
                .positional("value", {
                  type: "string",
                  describe: "JSON value for set; wrap strings in quotes",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseIssueId(argv.id as string);
            const operation = argv.operation as string;

            if (operation === "get") {
              await runReadCommand(format, (ctx) =>
                handleIssueMetaGet(id, argv.path as string | undefined, ctx),
              );
              return;
            }

            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            try {
              const path = argv.path as string | undefined;
              if (!path) {
                throw new CliValidationError("invalid_input", "Metadata path is required");
              }
              const rawValue = argv.value as string | undefined;
              if (operation === "set" && rawValue === undefined) {
                throw new CliValidationError("invalid_input", "Metadata value is required for set");
              }
              const result = operation === "set"
                ? await runBoardWrite(argv, format, async () => handleIssueMetaSet(
                  id,
                  path,
                  parseMetadataValue(rawValue!),
                  format,
                  root,
                ))
                : await runBoardWrite(argv, format, async () => handleIssueMetaUnset(id, path, format, root));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete an issue",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Issue ID (e.g. ISS-001)",
                })
                .option("hard", {
                  type: "boolean",
                  default: false,
                  describe: "Force physical removal (skip soft delete in team mode)",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseIssueId(argv.id as string);
            const hard = argv.hard as boolean;
            const { resolveAndNormalizeIssueRef } = await import("../core/ref-normalization.js");
            await runDeleteCommand(argv, format, false, async (ctx) => {
              const resolvedId = resolveAndNormalizeIssueRef(ctx.state, id);
              const issue = ctx.state.issueByID(resolvedId);
              return handleIssueDelete(resolvedId, format, ctx.root, hard, issue?.displayId ?? resolvedId);
            });
          },
        )
        .demandCommand(
          1,
          "Specify an issue subcommand: list, get, create, update, meta, delete",
        )
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// phase
// ---------------------------------------------------------------------------

export function registerPhaseCommand(yargs: Argv): Argv {
  return yargs.command(
    "phase",
    "Phase operations",
    (y) =>
      y
        .command(
          "list",
          "List all phases",
          (y2) => addNodeOption(addFormatOption(y2)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const nodeName = argv.node as string | undefined;
            if (nodeName) {
              const orchRoot = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
              if (!orchRoot) { writeOutput(formatError("not_found", "No .story/ project found.", format), format); process.exitCode = ExitCode.USER_ERROR; return; }
              const eff = resolveRootWithNode(orchRoot, nodeName, false, format);
              if (!eff.ok) { writeOutput(eff.output, format); process.exitCode = ExitCode.USER_ERROR; return; }
              await runReadCommandWithRoot(format, eff.root, handlePhaseList);
            } else {
              await runReadCommand(format, handlePhaseList);
            }
          },
        )
        .command(
          "current",
          "Show current phase",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handlePhaseCurrent);
          },
        )
        .command(
          "tickets",
          "List tickets in a phase",
          (y2) =>
            addFormatOption(
              y2.option("phase", {
                type: "string",
                demandOption: true,
                describe: "Phase ID",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const phaseId = argv.phase as string;
            await runReadCommand(format, (ctx) =>
              handlePhaseTickets(phaseId, ctx),
            );
          },
        )
        .command(
          "create",
          "Create a new phase",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .option("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase ID (lowercase alphanumeric with hyphens)",
                })
                .option("name", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase name",
                })
                .option("label", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase label (e.g. PHASE 5)",
                })
                .option("description", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase description",
                })
                .option("summary", {
                  type: "string",
                  describe: "Short summary",
                })
                .option("after", {
                  type: "string",
                  describe: "Insert after this phase ID",
                })
                .option("at-start", {
                  type: "boolean",
                  default: false,
                  describe: "Insert at the beginning",
                })
                .option("node", {
                  type: "string",
                  describe: "Node name (orchestrator only)",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const orchRoot = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!orchRoot) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, argv.node as string | undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output, format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handlePhaseCreate(
                {
                  id: argv.id as string,
                  name: argv.name as string,
                  label: argv.label as string,
                  description: argv.description as string,
                  summary: argv.summary as string | undefined,
                  after: argv.after as string | undefined,
                  atStart: argv.atStart as boolean,
                },
                format,
                eff.root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "rename <id>",
          "Rename/update phase metadata",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase ID",
                })
                .option("name", {
                  type: "string",
                  describe: "New name",
                })
                .option("label", {
                  type: "string",
                  describe: "New label",
                })
                .option("description", {
                  type: "string",
                  describe: "New description",
                })
                .option("summary", {
                  type: "string",
                  describe: "New summary",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = argv.id as string;
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handlePhaseRename(
                id,
                {
                  name: argv.name as string | undefined,
                  label: argv.label as string | undefined,
                  description: argv.description as string | undefined,
                  summary: argv.summary as string | undefined,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "move <id>",
          "Move a phase to a new position",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase ID to move",
                })
                .option("after", {
                  type: "string",
                  describe: "Place after this phase ID",
                })
                .option("at-start", {
                  type: "boolean",
                  default: false,
                  describe: "Move to the beginning",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = argv.id as string;
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handlePhaseMove(
                id,
                {
                  after: argv.after as string | undefined,
                  atStart: argv.atStart as boolean,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a phase",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Phase ID to delete",
                })
                .option("reassign", {
                  type: "string",
                  describe: "Move tickets/issues to this phase",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = argv.id as string;
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError(
                  "not_found",
                  "No .story/ project found.",
                  format,
                ),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handlePhaseDelete(
                id,
                argv.reassign as string | undefined,
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(
          1,
          "Specify a phase subcommand: list, current, tickets, create, rename, move, delete",
        )
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

export function registerSnapshotCommand(yargs: Argv): Argv {
  return yargs.command(
    "snapshot",
    "Save current project state for session diffs",
    (y: Argv) => addCommitOption(((y) =>
      addFormatOption(
        y.option("quiet", {
          type: "boolean",
          default: false,
          describe: "Suppress output (for hook usage)",
        }),
      ))(y)),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const quiet = argv.quiet as boolean;
      const root = (
        await import("../core/project-root-discovery.js")
      ).discoverProjectRoot();
      if (!root) {
        if (quiet) {
          process.stderr.write("No .story/ project found.\n");
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        writeOutput(
          formatError("not_found", "No .story/ project found.", format),
          format,
        );
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      try {
        const result = await runBoardWrite(argv, format, async () => handleSnapshot(root, format, { quiet }));
        if (!quiet && result.output) {
          writeOutput(result.output, format);
        }
        process.exitCode = result.exitCode ?? ExitCode.OK;
      } catch (err: unknown) {
        if (quiet) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(message + "\n");
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        if (err instanceof CliValidationError) {
          writeOutput(formatError(err.code, err.message, format), format);
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const { ProjectLoaderError } = await import("../core/errors.js");
        if (err instanceof ProjectLoaderError) {
          writeOutput(formatError(err.code, err.message, format), format);
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, format), format);
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// recap
// ---------------------------------------------------------------------------

export function registerRecapCommand(yargs: Argv): Argv {
  return yargs.command(
    "recap",
    "Session diff -- changes since last snapshot + suggested actions",
    (y) => addFormatOption(y),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      await runReadCommand(format, handleRecap);
    },
  );
}

// ---------------------------------------------------------------------------
// review-stats
// ---------------------------------------------------------------------------

export function registerReviewStatsCommand(yargs: Argv): Argv {
  return yargs.command(
    "review-stats",
    "Review efficiency metrics over review verdict artifacts",
    (y) =>
      addFormatOption(
        y.option("fleet", {
          type: "string",
          describe:
            "Scan every .story/ root under this directory. Root-level results are "
            + "authoritative; the cross-root figure is a sum of root observations "
            + "that may include duplicates, not unique fleet activity",
        }).option("open-window", {
          type: "boolean",
          describe:
            "T-495: open the review-contract measurement window. Records the current "
            + "REVIEW.md hash as the week's baseline. Refuses if a window is already "
            + "open; a window cannot be re-based once opened",
        }).option("close-window", {
          type: "boolean",
          describe:
            "T-495: close the measurement window, recording the three divergence "
            + "observations. Refuses before seven days have elapsed, refuses to "
            + "re-close, and refuses below the twenty-round population floor",
        }).option("contract", {
          type: "boolean",
          describe:
            "T-495: print the review-contract population and its verdict. The verdict "
            + "is three threshold lines and is never an authorisation",
        }),
      ),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      // `--open-window` WRITES, but it writes `.story/config.json` under the
      // project lock taken inside `openContractWindow`, not through the ledger
      // mutation path (config is not a ledger item and has no merge driver).
      // The read path is still correct for reaching the handler; the lock and
      // the atomic replace are where the safety lives.
      await runReadCommand(format, (ctx) =>
        handleReviewStats(
          {
            ...(argv.fleet === undefined ? {} : { fleet: String(argv.fleet) }),
            ...(argv["open-window"] === true ? { openWindow: true } : {}),
            ...(argv["close-window"] === true ? { closeWindow: true } : {}),
            ...(argv.contract === true ? { contract: true } : {}),
          },
          ctx,
        ),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export function registerExportCommand(yargs: Argv): Argv {
  return yargs.command(
    "export",
    "Self-contained project document for sharing",
    (y) =>
      addFormatOption(
        y
          .option("phase", {
            type: "string",
            describe: "Export a single phase by ID",
          })
          .option("all", {
            type: "boolean",
            describe: "Export entire project",
          })
          .conflicts("phase", "all")
          .check((argv) => {
            if (!argv.phase && !argv.all) {
              throw new Error(
                "Specify either --phase <id> or --all",
              );
            }
            return true;
          }),
      ),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const mode = argv.all ? "all" : "phase";
      const phaseId = (argv.phase as string | undefined) ?? null;
      await runReadCommand(format, (ctx) =>
        handleExport(ctx, mode as "all" | "phase", phaseId),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// reference
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// note
// ---------------------------------------------------------------------------

export function registerNoteCommand(yargs: Argv): Argv {
  return yargs.command(
    "note",
    "Manage notes",
    (y) =>
      y
        .command(
          "list",
          "List notes",
          (y2) =>
            addFormatOption(
              y2
                .option("status", {
                  type: "string",
                  choices: ["active", "archived"],
                  describe: "Filter by status",
                })
                .option("tag", {
                  type: "string",
                  describe: "Filter by tag",
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleNoteList(
                {
                  status: argv.status as string | undefined,
                  tag: argv.tag as string | undefined,
                },
                ctx,
              ),
            );
          },
        )
        .command(
          "get <id>",
          "Get a note",
          (y2) =>
            addFormatOption(
              y2.positional("id", {
                type: "string",
                demandOption: true,
                describe: "Note ID (e.g. N-001)",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseNoteId(argv.id as string);
            await runReadCommand(format, (ctx) => handleNoteGet(id, ctx));
          },
        )
        .command(
          "create",
          "Create a note",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .option("content", {
                  type: "string",
                  describe: "Note content",
                })
                .option("title", {
                  type: "string",
                  describe: "Note title",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read content from stdin",
                })
                .conflicts("content", "stdin")
                .check((argv) => {
                  if (!argv.content && !argv.stdin) {
                    throw new Error(
                      "Specify either --content or --stdin",
                    );
                  }
                  return true;
                }),
              { tags: { ...SPLIT_LIST, describe: "Tags for the note" } },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            try {
              let content: string;
              if (argv.stdin) {
                content = await readStdinContent();
              } else {
                content = argv.content as string;
              }
              const result = await runBoardWrite(argv, format, async () => handleNoteCreate(
                {
                  content,
                  title: argv.title as string | undefined ?? null,
                  tags: argv.tags as string[] | undefined,
                },
                format,
                root,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update a note",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Note ID (e.g. N-001)",
                })
                .option("content", {
                  type: "string",
                  describe: "New content",
                })
                .option("title", {
                  type: "string",
                  describe: "New title",
                })
                .option("clear-tags", {
                  type: "boolean",
                  describe: "Clear all tags",
                })
                .option("status", {
                  type: "string",
                  choices: ["active", "archived"],
                  describe: "New status",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read content from stdin",
                })
                .option("mode", {
                  type: "string",
                  choices: ["replace", "append"],
                  describe: "replace (default) or append after a blank line",
                })
                .option("confirm-replace", {
                  type: "boolean",
                  describe: "Allow shrinking a 1000+ char note below 20%",
                })
                .conflicts("content", "stdin")
                .conflicts("tags", "clear-tags"),
              {
                tags: {
                  ...SPLIT_LIST,
                  describe: "New tags (replaces existing)",
                  requireValue: "Use --clear-tags to clear tags.",
                },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseNoteId(argv.id as string);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            let content: string | undefined;
            if (argv.stdin) {
              content = await readStdinContent();
            } else {
              content = argv.content as string | undefined;
            }

            try {
              const result = await runBoardWrite(argv, format, async () => handleNoteUpdate(
                id,
                {
                  content,
                  title: argv.title === ""
                    ? null
                    : (argv.title as string | undefined),
                  tags: argv.tags as string[] | undefined,
                  clearTags: argv["clear-tags"] as boolean,
                  status: argv.status as string | undefined,
                  mode: argv.mode as "replace" | "append" | undefined,
                  confirmReplace: argv["confirm-replace"] as boolean | undefined,
                },
                format,
                root,
                { confirm: "--confirm-replace", append: "--mode append" },
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a note",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Note ID (e.g. N-001)",
                })
                .option("hard", {
                  type: "boolean",
                  default: false,
                  describe: "Force physical removal (skip soft delete in team mode)",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseNoteId(argv.id as string);
            const hard = argv.hard as boolean;
            const { resolveAndNormalizeNoteRef } = await import("../core/ref-normalization.js");
            await runDeleteCommand(argv, format, false, async (ctx) => {
              const resolvedId = resolveAndNormalizeNoteRef(ctx.state, id);
              const note = ctx.state.noteByID(resolvedId);
              return handleNoteDelete(resolvedId, format, ctx.root, hard, note?.displayId ?? resolvedId);
            });
          },
        )
        .demandCommand(
          1,
          "Specify a note subcommand: list, get, create, update, delete",
        )
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// arrangement (T-473)
// ---------------------------------------------------------------------------

/**
 * ISS-1191: the root discovery, format parsing and error classification the
 * capacity-maintenance subcommands share with every other arrangement
 * subcommand, factored out rather than pasted a third and fourth time.
 */
async function runArrangementMaintenance(
  argv: { format?: string } & BoardWriteArgv,
  run: (format: ReturnType<typeof parseOutputFormat>, root: string) => Promise<{ output: string; exitCode?: number }>,
): Promise<void> {
  const format = parseOutputFormat(argv.format as string);
  const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
  if (!root) {
    writeOutput(formatError("not_found", "No .story/ project found.", format), format);
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  try {
    const result = await runBoardWrite(argv, format, () => run(format, root));
    writeOutput(result.output, format);
    process.exitCode = result.exitCode ?? ExitCode.OK;
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const { ProjectLoaderError } = await import("../core/errors.js");
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}

/**
 * ISS-1078 ([R1-FIX 8]): parses the `key=value,key=value,...` fields of one
 * `--party` entry, tolerating a comma INSIDE a value when the value is
 * double-quoted (`modelTier="opus, fallback sonnet"`). Grammar:
 *
 * - A value may be wrapped in `"..."`; its closing quote must be immediately
 *   followed by `,` or end-of-string (anything else after the close-quote is
 *   refused as malformed, never silently truncated).
 * - Inside quotes, `\"` is a literal quote and `\\` is a literal backslash;
 *   no other backslash escape is recognized (refused by name).
 * - An unquoted value may not contain a comma (unchanged from before this
 *   fix) but may contain a raw `"` or `\` literally -- every existing
 *   unquoted spec still parses byte-for-byte identically.
 * - An unterminated quote is refused by name, never treated as an unquoted
 *   value containing a literal quote character.
 *
 * `--party` is a single CLI argument, so a value containing a comma needs
 * BOTH this quoting AND the shell's own quoting to survive argv splitting,
 * e.g. `--party 'role=pen,client=codex,identityAnchor=session-1,modelTier="opus, fallback sonnet"'`
 * (outer single-quotes are the shell's job, inner double-quotes are this
 * parser's job) -- stated in the `--party` help text with this exact example.
 */
function parsePartyFields(spec: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const n = spec.length;
  let i = 0;
  // `more` tracks whether a comma was actually consumed as a separator, so a
  // TRAILING comma (nothing after it) still forces one more iteration that
  // hits the `eq === -1` malformed check below -- matching the pre-fix
  // `spec.split(",")` behavior, which produced a trailing empty segment and
  // threw the same error. Ending cleanly at end-of-string (no trailing
  // comma) does NOT force another iteration.
  let more = true;
  while (more) {
    more = false;
    const eq = spec.indexOf("=", i);
    // A key never contains a comma, so a comma appearing BEFORE the next `=`
    // means the fragment between `i` and that comma has no `=` at all --
    // malformed, e.g. a stray `junk` between two valid `key=value` pairs.
    // Without this check, `indexOf("=", i)` would search PAST that comma and
    // silently absorb the garbage fragment into the next field's key (fixed
    // post-gate-1, codex round 1: this is what the un-narrowed scan did).
    const commaBeforeEq = spec.indexOf(",", i);
    if (eq === -1 || (commaBeforeEq !== -1 && commaBeforeEq < eq)) {
      const badFragment = commaBeforeEq !== -1 ? spec.slice(i, commaBeforeEq) : spec.slice(i);
      throw new CliValidationError(
        "invalid_input",
        `Malformed --party entry (expected key=value pairs): "${spec}"` +
        (badFragment.length > 0 ? ` (offending fragment: "${badFragment}")` : " (trailing comma with no following field)"),
      );
    }
    const key = spec.slice(i, eq).trim();
    let cursor = eq + 1;
    let value: string;
    if (spec[cursor] === "\"") {
      let out = "";
      let j = cursor + 1;
      let closed = false;
      while (j < n) {
        const ch = spec[j];
        if (ch === "\\") {
          const next = spec[j + 1];
          if (next === "\"" || next === "\\") {
            out += next;
            j += 2;
            continue;
          }
          throw new CliValidationError(
            "invalid_input",
            `Malformed --party entry: invalid escape "\\${next ?? ""}" in "${spec}" (only \\" and \\\\ are recognized)`,
          );
        }
        if (ch === "\"") {
          closed = true;
          j += 1;
          break;
        }
        out += ch;
        j += 1;
      }
      if (!closed) {
        throw new CliValidationError("invalid_input", `Malformed --party entry: unterminated quote in "${spec}"`);
      }
      if (j < n && spec[j] !== ",") {
        throw new CliValidationError(
          "invalid_input",
          `Malformed --party entry: unexpected characters after closing quote in "${spec}"`,
        );
      }
      value = out;
      if (j < n) {
        cursor = j + 1;
        more = true;
      } else {
        cursor = j;
      }
    } else {
      const comma = spec.indexOf(",", cursor);
      if (comma === -1) {
        value = spec.slice(cursor).trim();
        cursor = n;
      } else {
        value = spec.slice(cursor, comma).trim();
        cursor = comma + 1;
        more = true;
      }
    }
    fields[key] = value;
    i = cursor;
  }
  return fields;
}

/**
 * Parses one `--party role=pen,client=codex,identityAnchor=abc123` entry.
 * Exported for direct parser-level testing (ISS-1078) -- the argv-level CLI
 * integration test in arrangement-party-spec.test.ts covers the full
 * shell-quoting-plus-parser-quoting path separately.
 */
export function parsePartySpec(spec: string): ArrangementParty {
  const fields = parsePartyFields(spec);
  const { role, client, identityAnchor, modelTier } = fields;
  if (!role || !ARRANGEMENT_ROLES.includes(role as (typeof ARRANGEMENT_ROLES)[number])) {
    throw new CliValidationError("invalid_input", `--party role must be one of ${ARRANGEMENT_ROLES.join(", ")}: "${spec}"`);
  }
  if (client !== "claude" && client !== "codex") {
    throw new CliValidationError("invalid_input", `--party client must be "claude" or "codex": "${spec}"`);
  }
  if (!identityAnchor) {
    throw new CliValidationError("invalid_input", `--party identityAnchor is required: "${spec}"`);
  }
  return {
    role: role as (typeof ARRANGEMENT_ROLES)[number],
    client,
    identityAnchor,
    ...(modelTier !== undefined && { modelTier }),
  };
}

/** N-131 / T-530: `storybloq duet spawn`, the pen starts a visible worker session that handshakes by itself. */
export function registerDuetCommand(yargs: Argv): Argv {
  return yargs.command(
    "duet",
    "Duet-mode worker sessions",
    (y) =>
      y
        .command(
          "spawn",
          "Start a worker session in a new terminal window with its arrangement created and its handshake armed (the OS opens it; nothing else is required)",
          (y2) => arrayOption(
            addFormatOption(y2
              .option("name", { type: "string", describe: "Worker session name; the address the pen messages (required unless --recover)" })
              .option("pen", { type: "string", describe: "The pen's own session name, written into the worker's role (required unless --recover)" })
              .option("arrangement", { type: "string", choices: ["auto", "none"], describe: "auto (default for a Claude pen with a task id): create the arrangement, start coordination and put the nonce in the role; none: manual handshake" })
              .option("model", { type: "string", describe: "Model id or alias for `claude --model`; omitted: opus, the hands tier, and the output says it was the default" })
              .option("dir", { type: "string", describe: "Directory the worker starts in (default: this project); a federation node checkout, or a worktree with no .story, whose /story then loads this board" })
              .option("role", { type: "string", describe: "Role file to use instead of the generated default (the handshake section is appended when an arrangement is created)" })
              .option("permission-mode", { type: "string", describe: "claude --permission-mode for the worker; omitted: auto, or bypassPermissions when the pen itself runs in bypass" })
              .option("terminal", { type: "string", describe: "macOS: open with this terminal app instead of the default handler" })
              .option("auto-load", { type: "boolean", default: true, describe: "Start the window with /story as its first prompt; --no-auto-load leaves the prompt empty" })
              .option("pen-task-id", { type: "string", describe: "The pen's client task id when the environment does not carry it (CLAUDE_CODE_SESSION_ID)" })
              .option("print", { type: "boolean", default: false, describe: "Print the command and the role it would write; creates nothing and writes nothing" })
              .option("recover", { type: "boolean", default: false, describe: "List interrupted spawns under .story/spawn/ with their reconciled state; launches nothing" })
              .check((argv) => {
                if (argv.recover) return true;
                if (!argv.name || !argv.pen) throw new CliValidationError("invalid_input", "--name and --pen are required (or pass --recover to list interrupted spawns)");
                return true;
              })),
            "bounds",
            { ...SPLIT_LIST, describe: "Ticket/issue refs the arrangement covers (repeatable); required for the automatic handshake" },
          ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            try {
              const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
              if (!root) throw new CliValidationError("not_found", "No .story/ project found.");
              const { handleDuetSpawn } = await import("./commands/duet-spawn.js");
              const result = await handleDuetSpawn({
                name: argv.name as string | undefined,
                pen: argv.pen as string | undefined,
                model: argv.model as string | undefined,
                dir: argv.dir as string | undefined,
                role: argv.role as string | undefined,
                permissionMode: argv["permission-mode"] as string | undefined,
                terminal: argv.terminal as string | undefined,
                print: argv.print as boolean,
                arrangement: argv.arrangement as "auto" | "none" | undefined,
                bounds: argv.bounds as string[] | undefined,
                autoLoad: argv["auto-load"] as boolean,
                penTaskId: argv["pen-task-id"] as string | undefined,
                recover: argv.recover as boolean,
              }, format, root);
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (error) {
              const code = error instanceof CliValidationError ? error.code : "io_error";
              writeOutput(formatError(code, error instanceof Error ? error.message : String(error), format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(1, "Specify a duet subcommand"),
    () => {},
  );
}

export function registerArrangementCommand(yargs: Argv): Argv {
  return yargs.command(
    "arrangement",
    "Manage duet-mode arrangements",
    (y) =>
      y
        .command(
          "coordinate <id>",
          "Record a pen-owned duet coordination operation",
          (y: Argv) => addCommitOption(((y2) => addFormatOption(y2
            .positional("id", { type: "string", demandOption: true })
            .option("json", { type: "string", demandOption: true, describe: "Typed start/receipt/assign/update/recover operation including expectedSessionId and expectedRevision" })
            .option("client-task-id", { type: "string", describe: "Explicit caller task identity" })))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            try {
              const input = parseDuetOperation(argv.id as string, argv.json as string, argv["client-task-id"] as string | undefined);
              const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
              if (!root) throw new CliValidationError("not_found", "No .story/ project found.");
              const result = await runBoardWrite(argv, format, async () => handleDuetCoordinate(input, format, root));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (error) {
              const { ProjectLoaderError } = await import("../core/errors.js");
              const code = error instanceof CliValidationError || error instanceof ProjectLoaderError ? error.code : "io_error";
              writeOutput(formatError(code, error instanceof Error ? error.message : String(error), format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "list",
          "List arrangements",
          (y2) =>
            addFormatOption(
              y2.option("lifecycle", {
                type: "string",
                choices: ARRANGEMENT_LIFECYCLE,
                describe: "Filter by lifecycle",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleArrangementList({ lifecycle: argv.lifecycle as string | undefined }, ctx),
            );
          },
        )
        .command(
          "get <id>",
          "Get an arrangement",
          (y2) =>
            addFormatOption(
              y2.positional("id", {
                type: "string",
                demandOption: true,
                describe: "Arrangement ID (e.g. a-[canonical])",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleArrangementGet(argv.id as string, ctx));
          },
        )
        .command(
          "create",
          "Create a new arrangement",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("unreachability-irreversible", {
                    type: "string",
                    choices: ["hold", "escalate"],
                    demandOption: true,
                    describe: "What to do on irreversible work when the arrangement is unreachable",
                  })
                  .option("unreachability-reversible", {
                    type: "string",
                    choices: ["hold", "escalate", "proceed"],
                    describe: "What to do on reversible work when the arrangement is unreachable",
                  }),
                {
                  // Atomic ticket/issue refs -- a comma can never be part of one.
                  bounds: { ...SPLIT_LIST, describe: "Ticket/issue refs this arrangement covers (repeatable)" },
                  // "role=pen,client=claude,identityAnchor=..." -- the comma is
                  // the field separator WITHIN one value, so it must never be
                  // split by this layer; parsePartySpec below does its own
                  // splitting per entry.
                  party: {
                    ...LITERAL_KEEP_BLANK,
                    describe:
                      "role=pen|worker,client=claude|codex,identityAnchor=... (repeatable). " +
                      "A value containing a comma must be double-quoted, e.g. modelTier=\"opus, fallback sonnet\" " +
                      "(\\\" and \\\\ are the only recognized escapes inside quotes; identityAnchor's own format " +
                      "never contains a comma, so quoting mainly matters for free-text fields like modelTier). " +
                      "Since --party is a single shell argument, also quote the WHOLE entry at the shell level: " +
                      "--party 'role=pen,client=codex,identityAnchor=session-1,modelTier=\"opus, fallback sonnet\"'",
                  },
                },
              ).demandOption(["bounds", "party"]),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const parties = (argv.party as string[]).map(parsePartySpec);
              const result = await runBoardWrite(argv, format, async () => handleArrangementCreate(
                {
                  bounds: argv.bounds as string[],
                  parties,
                  onIrreversibleWork: argv["unreachability-irreversible"] as "hold" | "escalate",
                  onReversibleWork: argv["unreachability-reversible"] as "hold" | "escalate" | "proceed" | undefined,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update an arrangement",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Arrangement ID (e.g. a-[canonical])",
                })
                .option("lifecycle", {
                  type: "string",
                  choices: ARRANGEMENT_LIFECYCLE,
                  describe: "New lifecycle",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleArrangementUpdate(
                argv.id as string,
                { lifecycle: argv.lifecycle as string | undefined },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        // ISS-1191: capacity maintenance. Both are CLI only and both are
        // pen-authorized, exactly like `coordinate`.
        .command(
          "compact <id>",
          "Compact an arrangement's coordination checkpoint (reduces resolved assignments)",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Arrangement ID (e.g. a-[canonical])" })
                .option("client-task-id", { type: "string", describe: "Caller's client task id; must match the arrangement's pen" }),
            ))(y)),
          async (argv) => {
            await runArrangementMaintenance(argv, (format, root) =>
              handleArrangementCompact(argv.id as string, { clientTaskId: argv.clientTaskId as string | undefined }, format, root),
            );
          },
        )
        .command(
          "rotate <id>",
          "Close an arrangement and carry its open work forward into a fresh successor",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Arrangement ID (e.g. a-[canonical])" })
                .option("client-task-id", { type: "string", describe: "Caller's client task id; must match the arrangement's pen" }),
            ))(y)),
          async (argv) => {
            await runArrangementMaintenance(argv, (format, root) =>
              handleArrangementRotate(argv.id as string, { clientTaskId: argv.clientTaskId as string | undefined }, format, root),
            );
          },
        )
        // ISS-1290: owner-authorized succession; an attributed claim, not
        // authentication. Liveness is read from this machine's roster only.
        .command(
          "rebind <id>",
          "Rebind one party of an arrangement into a successor (owner-authorized succession; the original is closed)",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Arrangement ID (e.g. a-[canonical])" })
                .option("role", { type: "string", choices: ["pen", "worker"] as const, demandOption: true, describe: "Which party to replace" })
                .option("to", { type: "string", demandOption: true, describe: "The new task's client task id" })
                .option("client", { type: "string", choices: ["claude", "codex"] as const, describe: "The new task's client (default: the replaced party's client)" })
                .option("evidence", { type: "string", demandOption: true, describe: "Who authorized the succession and why (recorded verbatim, at most 4000 characters)" })
                .option("client-task-id", { type: "string", describe: "Caller's client task id (recorded as recordedBy)" }),
            ))(y)),
          async (argv) => {
            await runArrangementMaintenance(argv, (format, root) =>
              handleArrangementRebind(argv.id as string, {
                role: argv.role as "pen" | "worker",
                to: argv.to as string,
                client: argv.client as "claude" | "codex" | undefined,
                evidence: argv.evidence as string,
                clientTaskId: argv.clientTaskId as string | undefined,
              }, format, root),
            );
          },
        )
        .demandCommand(1, "Specify an arrangement subcommand: list, get, create, update, compact, rotate, rebind, coordinate")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// ruling (T-476)
// ---------------------------------------------------------------------------

/** T-522: the four narrative fields a ruling may carry beside its verbatim text. Labelled, never merged into the quote. */
const RULING_NARRATIVE_OPTIONS = {
  context: { type: "string", describe: "Narrative: the situation the decision answers (recorded beside the verbatim text, never inside it)" },
  alternatives: { type: "string", describe: "Narrative: what else was considered" },
  consequences: { type: "string", describe: "Narrative: what follows from the decision" },
  "reconsider-when": { type: "string", describe: "Narrative: the condition under which to revisit it" },
} as const;

function narrativeArgs(argv: Record<string, unknown>): NarrativeArgs {
  return {
    context: argv.context as string | undefined,
    alternatives: argv.alternatives as string | undefined,
    consequences: argv.consequences as string | undefined,
    reconsiderWhen: argv["reconsider-when"] as string | undefined,
  };
}

/** Root discovery plus the ruling write handlers' shared error rendering. */
async function runRulingWrite(argv: BoardWriteArgv, format: RulingOutputFormat, fn: (root: string) => Promise<RulingCommandResult>): Promise<void> {
  const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
  if (!root) {
    writeOutput(formatError("not_found", "No .story/ project found.", format), format);
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  try {
    const result = await runBoardWrite(argv, format, () => fn(root));
    writeOutput(result.output, format);
    process.exitCode = result.exitCode ?? ExitCode.OK;
    // T-528: a ruling write succeeded, so the projection is regenerated once.
    if (process.exitCode === ExitCode.OK) await (await import("./commands/projection.js")).refreshProjectionAfterWrite(root);
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const { ProjectLoaderError } = await import("../core/errors.js");
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}

export function registerRulingCommand(yargs: Argv): Argv {
  return yargs.command(
    "ruling",
    "Manage owner-ruling attestation records",
    (y) =>
      y
        .command(
          "list",
          "List rulings",
          (y2) =>
            addFormatOption(
              y2
                .option("scope-tag", { type: "string", describe: "Filter by scope tag" })
                .option("superseded", { type: "boolean", describe: "Filter to superseded (true) or current (false) rulings only" })
                .option("status", {
                  type: "string",
                  choices: RULING_LIFECYCLES,
                  describe: "Filter by lifecycle. `accepted` is what binds now (superseded records are their own bucket); `--format md` renders the Decisions listing",
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleRulingList(
                { scopeTag: argv["scope-tag"] as string | undefined, superseded: argv.superseded as boolean | undefined, status: argv.status as string | undefined },
                ctx,
              ),
            );
          },
        )
        .command(
          "get <id>",
          "Get a ruling",
          (y2) =>
            addFormatOption(
              y2.positional("id", { type: "string", demandOption: true, describe: "Ruling ID (e.g. r-[canonical])" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleRulingGet(argv.id as string, ctx));
          },
        )
        .command(
          "create",
          "Record a new ruling. Text is byte-verbatim: no markdown cleanup, no editing inside the quote.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("text", { type: "string", demandOption: true, describe: "Verbatim ruling text" })
                  .option("attribution", {
                    type: "string",
                    choices: RULING_ATTRIBUTIONS,
                    demandOption: true,
                    describe:
                      "Claimed source of this ruling -- a CLAIM asserted by the recorder, not verified by storybloq. " +
                      "See src/core/ruling.ts's module docblock for the full docs statement.",
                  })
                  .option("date", { type: "string", demandOption: true, describe: "Ruling date (YYYY-MM-DD)" })
                  .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" })
                  .options(RULING_NARRATIVE_OPTIONS),
                {
                  "scope-tag": { ...SPLIT_LIST, describe: "Scope tag (repeatable)" },
                  cites: {
                    ...SPLIT_LIST,
                    describe:
                      "Ticket or issue this ruling binds (repeatable). Adds the new ruling id to that item's citesRulings, " +
                      "which is how the ruling reaches an agent working the item. Never replaces existing citations.",
                  },
                },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleRulingCreate(
                {
                  text: argv.text as string,
                  attribution: argv.attribution as string,
                  date: argv.date as string,
                  scopeTags: (argv["scope-tag"] as string[] | undefined) ?? [],
                  cites: argv.cites as string[] | undefined,
                  clientTaskId: argv["client-task-id"] as string | undefined,
                  ...narrativeArgs(argv),
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
              if (process.exitCode === ExitCode.OK) await (await import("./commands/projection.js")).refreshProjectionAfterWrite(root);
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "supersede <id>",
          "Supersede a ruling -- link an existing ruling with --with, or create a new superseding ruling with --text/--attribution/--date",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .positional("id", { type: "string", demandOption: true, describe: "Ruling ID being superseded" })
                  .option("with", { type: "string", describe: "Existing ruling ID that supersedes <id>" })
                  .option("text", { type: "string", describe: "Verbatim text for a new superseding ruling" })
                  .option("attribution", { type: "string", choices: RULING_ATTRIBUTIONS, describe: "Claimed source of the new ruling" })
                  .option("date", { type: "string", describe: "Date of the new ruling (YYYY-MM-DD)" })
                  .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" })
                  .option("branch", { type: "boolean", default: false, describe: "Knowingly record a second successor for <id> (a branch: no single ruling is current until resolved)" })
                  .options(RULING_NARRATIVE_OPTIONS)
                  .conflicts("with", "text")
                  .conflicts("with", "attribution")
                  .conflicts("with", "date"),
                { "scope-tag": { ...SPLIT_LIST, describe: "Scope tag for a new superseding ruling (repeatable)" } },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleRulingSupersede(
                argv.id as string,
                {
                  withId: argv.with as string | undefined,
                  text: argv.text as string | undefined,
                  attribution: argv.attribution as string | undefined,
                  date: argv.date as string | undefined,
                  scopeTags: argv["scope-tag"] as string[] | undefined,
                  clientTaskId: argv["client-task-id"] as string | undefined,
                  branch: argv.branch as boolean,
                  ...narrativeArgs(argv),
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
              if (process.exitCode === ExitCode.OK) await (await import("./commands/projection.js")).refreshProjectionAfterWrite(root);
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "propose",
          "Propose a ruling (T-522). A proposal binds nothing until `ruling accept` records who ruled; drafting a replacement revokes nothing.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("text", { type: "string", demandOption: true, describe: "Verbatim proposed text" })
                  .option("attribution", { type: "string", choices: RULING_ATTRIBUTIONS, demandOption: true, describe: "Claimed source of the proposal (a CLAIM, not verified by storybloq)" })
                  .option("date", { type: "string", demandOption: true, describe: "Proposal date (YYYY-MM-DD)" })
                  .option("proposes-to-supersede", { type: "string", describe: "Accepted ruling this proposal would replace once accepted; refused if the target is dangling or not accepted" })
                  .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" })
                  .options(RULING_NARRATIVE_OPTIONS),
                {
                  "scope-tag": { ...SPLIT_LIST, describe: "Scope tag (repeatable)" },
                  for: { ...SPLIT_LIST, describe: "Ticket or issue the proposal is for (repeatable). Written on the proposal only; the item gains the citation at accept, never before" },
                },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runRulingWrite(argv, format, (root) =>
              handleRulingPropose(
                {
                  text: argv.text as string,
                  attribution: argv.attribution as string,
                  date: argv.date as string,
                  scopeTags: (argv["scope-tag"] as string[] | undefined) ?? [],
                  proposesToSupersede: argv["proposes-to-supersede"] as string | undefined,
                  proposedFor: argv.for as string[] | undefined,
                  clientTaskId: argv["client-task-id"] as string | undefined,
                  ...narrativeArgs(argv),
                },
                format,
                root,
              ),
            );
          },
        )
        .command(
          "accept <id>",
          "Accept a proposed ruling (T-522): records a claim of authority and cites it from every item it was proposed for, in one transaction. --revision is the digest of what was reviewed (from `ruling get`), not proof of who approved.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Proposed ruling ID" })
                .option("revision", { type: "string", demandOption: true, describe: "payloadDigest of the proposal as reviewed; refused if the digest-covered payload changed since (narrative edits do not change it)" })
                .option("attribution", { type: "string", choices: RULING_ATTRIBUTIONS, demandOption: true, describe: "Claimed source of the acceptance" })
                .option("date", { type: "string", demandOption: true, describe: "Acceptance date (YYYY-MM-DD)" })
                .option("branch", { type: "boolean", default: false, describe: "Knowingly accept a second successor for the proposal's target (a branch)" })
                .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runRulingWrite(argv, format, (root) =>
              handleRulingAccept(
                argv.id as string,
                {
                  revision: argv.revision as string,
                  attribution: argv.attribution as string,
                  date: argv.date as string,
                  branch: argv.branch as boolean,
                  clientTaskId: argv["client-task-id"] as string | undefined,
                },
                format,
                root,
              ),
            );
          },
        )
        .command(
          "withdraw <id>",
          "Withdraw a proposed ruling (T-522). Proposed records only; an accepted ruling is superseded, never withdrawn.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Proposed ruling ID" })
                .option("reason", { type: "string", describe: "Why it is withdrawn (recorded on the record)" })
                .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runRulingWrite(argv, format, (root) =>
              handleRulingWithdraw(
                argv.id as string,
                { reason: argv.reason as string | undefined, clientTaskId: argv["client-task-id"] as string | undefined },
                format,
                root,
              ),
            );
          },
        )
        .demandCommand(1, "Specify a ruling subcommand: list, get, create, supersede, propose, accept, withdraw")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// gate-ack (T-474)
// ---------------------------------------------------------------------------

export function registerGateAckCommand(yargs: Argv): Argv {
  return yargs.command(
    "gate-ack",
    "Manage duet-mode gate-ack records",
    (y) =>
      y
        .command(
          "list",
          "List gate-acks",
          (y2) =>
            addFormatOption(
              y2
                .option("arrangement", { type: "string", describe: "Filter by arrangement ID" })
                .option("ticket", { type: "string", describe: "Filter by ticket ref" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleGateAckList({ arrangement: argv.arrangement as string | undefined, ticket: argv.ticket as string | undefined }, ctx),
            );
          },
        )
        .command(
          "get <id>",
          "Get a gate-ack",
          (y2) =>
            addFormatOption(
              y2.positional("id", { type: "string", demandOption: true, describe: "Gate-ack ID (e.g. g-[canonical])" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleGateAckGet(argv.id as string, ctx));
          },
        )
        .command(
          "create",
          "Create a gate-ack",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .option("arrangement", { type: "string", demandOption: true, describe: "Arrangement ID this gate-ack authorizes against" })
                .option("gate", { type: "string", demandOption: true, describe: "Gate name declared on the arrangement (e.g. plan-ack, pre-commit-ack)" })
                .option("ticket", { type: "string", demandOption: true, describe: "Ticket ref this ack applies to" })
                .option("plan-file", { type: "string", describe: "Path to plan.md -- computes a plan-hash pin" })
                .option("from-staged", { type: "boolean", describe: "Compute a tree-digest pin from the currently staged index" })
                .option("codex-session-id", { type: "string", describe: "Independent-review session id, if any (acceptance 7)" })
                .option("verdict", { type: "string", describe: "Independent-review verdict, if any (acceptance 7)" })
                .option("rounds", { type: "number", describe: "Independent-review round count, if any (acceptance 7)" })
                .option("deltas", {
                  type: "string",
                  describe:
                    "Ratify-with-deltas text. For pre-commit-ack, restricted BY CONVENTION to non-mutating caveats " +
                    "(a note, a follow-up-issue pointer) -- never a condition requiring the staged content to differ, " +
                    "since by the time this ack is checked the commit it applies to has already been made.",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleGateAckCreate(
                {
                  arrangement: argv.arrangement as string,
                  gate: argv.gate as string,
                  ticket: argv.ticket as string,
                  planFile: argv["plan-file"] as string | undefined,
                  fromStaged: argv["from-staged"] as boolean | undefined,
                  codexSessionId: argv["codex-session-id"] as string | undefined,
                  verdict: argv.verdict as string | undefined,
                  rounds: argv.rounds as number | undefined,
                  deltas: argv.deltas as string | undefined,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "contest <id>",
          "Mark a gate-ack contested (record + surfaced flag only, T-474 acceptance 6)",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Gate-ack ID" })
                .option("reason", { type: "string", demandOption: true, describe: "Why this ack is contested" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleGateAckContest(argv.id as string, argv.reason as string, format, root));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(1, "Specify a gate-ack subcommand: list, get, create, contest")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// landings (T-477)
// ---------------------------------------------------------------------------

export function registerLandingsCommand(yargs: Argv): Argv {
  return yargs.command(
    "landings",
    "Commits that touched tickets/issues, with review coverage (CLI-only; no MCP tool)",
    (y) =>
      addFormatOption(
        y
          .option("since", {
            type: "string",
            describe: "Show landings after this ref (exclusive), instead of the last 200 commits on HEAD",
          })
          .option("limit", {
            type: "number",
            describe: "Cap the number of commits scanned (default 200 without --since; overrides that default with --since too)",
          }),
      ),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      await runReadCommand(format, (ctx) =>
        handleLandings(
          {
            since: argv.since as string | undefined,
            limit: argv.limit as number | undefined,
          },
          ctx,
        ),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// earmark (T-475)
// ---------------------------------------------------------------------------

export function registerEarmarkCommand(yargs: Argv): Argv {
  return yargs.command(
    "earmark",
    "Manage duet-mode assignment earmarks (pick-exclusion for tickets/issues)",
    (y) =>
      y
        .command(
          "get <ref>",
          "Get the earmark on a ticket or issue",
          (y2) =>
            addNodeOption(addFormatOption(
              y2.positional("ref", { type: "string", demandOption: true, describe: "Ticket or issue ref" }),
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const nodeName = argv.node as string | undefined;
            if (nodeName) {
              const orchRoot = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
              if (!orchRoot) { writeOutput(formatError("not_found", "No .story/ project found.", format), format); process.exitCode = ExitCode.USER_ERROR; return; }
              const eff = resolveRootWithNode(orchRoot, nodeName, false, format);
              if (!eff.ok) { writeOutput(eff.output, format); process.exitCode = ExitCode.USER_ERROR; return; }
              await runReadCommandWithRoot(format, eff.root, (ctx) => handleEarmarkGet(argv.ref as string, ctx));
            } else {
              await runReadCommand(format, (ctx) => handleEarmarkGet(argv.ref as string, ctx));
            }
          },
        )
        .command(
          "reserve <ref>",
          "Reserve a ticket or issue for a role, pending pickup",
          (y: Argv) => addCommitOption(((y2) =>
            addNodeOption(addFormatOption(
              y2
                .positional("ref", { type: "string", demandOption: true, describe: "Ticket or issue ref" })
                .option("role", { type: "string", choices: EARMARK_ROLES, demandOption: true, describe: "Role this reservation is held for" })
                .option("arrangement", { type: "string", describe: "Covering arrangement ID; required if more than one active arrangement covers this item" }),
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              // Node routing (ISS-1077) is handled BY the handler itself: `root`
              // stays the discovered (orchestrator) root always -- arrangements
              // only ever live there (Q3) -- and `node` is passed straight
              // through so the handler can resolve the item's own root
              // separately. This is deliberately NOT `resolveRootWithNode`'s
              // single-effective-root pattern (used by ticket/issue commands),
              // which has no way to express "two different roots for two
              // different purposes in the same call."
              const result = await runBoardWrite(argv, format, async () => handleEarmarkReserve(
                { ref: argv.ref as string, role: argv.role as (typeof EARMARK_ROLES)[number], arrangement: argv.arrangement as string | undefined },
                format,
                root,
                argv.node as string | undefined,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "assign <ref>",
          "Assign a ticket or issue's earmark directly to a live session (direct placement, or an explicit reserved -> assigned conversion)",
          (y: Argv) => addCommitOption(((y2) =>
            addNodeOption(addFormatOption(
              y2
                .positional("ref", { type: "string", demandOption: true, describe: "Ticket or issue ref" })
                .option("to", { type: "string", demandOption: true, describe: "Target session selector (id or unambiguous prefix)" })
                .option("role", { type: "string", choices: EARMARK_ROLES, demandOption: true, describe: "Role the target session must hold on the covering arrangement" })
                .option("arrangement", { type: "string", describe: "Covering arrangement ID; required if more than one active arrangement covers this item" }),
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleEarmarkAssign(
                {
                  ref: argv.ref as string,
                  to: argv.to as string,
                  role: argv.role as (typeof EARMARK_ROLES)[number],
                  arrangement: argv.arrangement as string | undefined,
                },
                format,
                root,
                argv.node as string | undefined,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "release <ref>",
          "Release (clear) a ticket or issue's earmark",
          (y: Argv) => addCommitOption(((y2) =>
            addNodeOption(addFormatOption(
              y2
                .positional("ref", { type: "string", demandOption: true, describe: "Ticket or issue ref" })
                .option("arrangement", { type: "string", describe: "Sanity check only: must match the earmark's own authorizing arrangement ID if given (release authorizes via that stored ID, not current bounds coverage)" }),
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleEarmarkRelease(
                { ref: argv.ref as string, arrangement: argv.arrangement as string | undefined },
                format,
                root,
                argv.node as string | undefined,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(1, "Specify an earmark subcommand: get, reserve, assign, release")
        .strict(),
    () => {},
  );
}

export function registerReferenceCommand(yargs: Argv): Argv {
  return yargs.command(
    "reference",
    "Print CLI command and MCP tool reference",
    (y) => addFormatOption(y),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const output = handleReference(format);
      writeOutput(output, format);
    },
  );
}

// ---------------------------------------------------------------------------
// setup-skill
// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

export function registerRecommendCommand(yargs: Argv): Argv {
  return yargs.command(
    "recommend",
    "Context-aware work suggestions",
    (y) =>
      addFormatOption(y).option("count", {
        type: "number",
        default: 5,
        describe: "Number of recommendations (1-10)",
      }).option("with-actionability", {
        type: "boolean",
        default: false,
        describe: "Show actionability status/reason per row plus an Excluded section (ISS-1154)",
      }),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const raw = Number(argv.count) || 5;
      const count = Math.max(1, Math.min(10, Math.floor(raw)));
      await runReadCommand(format, (ctx) => handleRecommend(ctx, count, Boolean(argv["with-actionability"])));
    },
  );
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export function registerDispatchCommand(yargs: Argv): Argv {
  return yargs.command(
    "dispatch [ids..]",
    "Dispatch work to Agent View background sessions",
    (y) =>
      // empty: "preserve" so a supplied blank or separator-only positional still
      // reaches the handler and is reported as an invalid ID, rather than
      // collapsing to [] and silently taking the recommendation branch.
      arrayPositional(addFormatOption(y), "ids", {
        comma: "split",
        empty: "preserve",
        trim: "segments",
        emptyAfterSplit: "drop",
        describe: "Ticket/issue IDs to dispatch (T-XXX, ISS-XXX)",
      })
        .option("recommend", {
          type: "boolean",
          default: false,
          describe: "Show recommended dispatch plan without executing",
        })
        .option("all", {
          type: "boolean",
          default: false,
          describe: "Dispatch all recommended items",
        })
        .option("count", {
          type: "number",
          default: 3,
          describe: "Number of recommendations to consider (1-8)",
        })
        .option("yes", {
          alias: "y",
          type: "boolean",
          default: false,
          describe: "Execute without confirmation",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Show plan without executing",
        }),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const raw = Number(argv.count) || 3;
      const count = Math.max(1, Math.min(8, Math.floor(raw)));
      const dryRun = !!(argv.recommend || argv.dryRun);

      const ids: readonly string[] | "all" = argv.all
        ? "all"
        : (argv.ids as string[] | undefined) ?? [];

      if (ids !== "all" && ids.length === 0) {
        await runReadCommand(format, (ctx) => handleDispatchRecommend(ctx, count));
        return;
      }

      await runReadCommand(format, (ctx) =>
        handleDispatch(ctx, { ids, count, dryRun, yes: !!argv.yes }),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// lesson
// ---------------------------------------------------------------------------

export function registerLessonCommand(yargs: Argv): Argv {
  return yargs.command(
    "lesson",
    "Manage lessons",
    (y) =>
      y
        .command(
          "list",
          "List lessons",
          (y2) =>
            addFormatOption(
              y2
                .option("status", {
                  type: "string",
                  choices: [...LESSON_STATUSES],
                  describe: "Filter by status",
                })
                .option("tag", {
                  type: "string",
                  describe: "Filter by tag",
                })
                .option("source", {
                  type: "string",
                  choices: [...LESSON_SOURCES],
                  describe: "Filter by source",
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleLessonList(
                {
                  status: argv.status as string | undefined,
                  tag: argv.tag as string | undefined,
                  source: argv.source as string | undefined,
                },
                ctx,
              ),
            );
          },
        )
        .command(
          "get <id>",
          "Get a lesson",
          (y2) =>
            addFormatOption(
              y2.positional("id", {
                type: "string",
                demandOption: true,
                describe: "Lesson ID (e.g. L-001)",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseLessonId(argv.id as string);
            await runReadCommand(format, (ctx) => handleLessonGet(id, ctx));
          },
        )
        .command(
          "digest",
          "Compiled ranked digest of active lessons",
          (y2) =>
            arrayOptions(
              addFormatOption(y2).option("limit", {
                type: "number",
                describe: "Cap the digest to the top N lessons by reinforcement (T-320)",
              }),
              {
                select: {
                  ...SPLIT_LIST,
                  describe: "Filter to lessons matching phase:<id>, component:<name>, or item:<id> selectors (T-320)",
                },
              },
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleLessonDigest(ctx, {
                limit: argv.limit as number | undefined,
                select: argv.select as string[] | undefined,
              }),
            );
          },
        )
        .command(
          "create",
          "Create a lesson",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .option("title", {
                  type: "string",
                  demandOption: true,
                  describe: "Lesson title",
                })
                .option("content", {
                  type: "string",
                  describe: "Lesson content (the actionable rule)",
                })
                .option("context", {
                  type: "string",
                  demandOption: true,
                  describe: "What happened that produced this lesson",
                })
                .option("source", {
                  type: "string",
                  demandOption: true,
                  choices: [...LESSON_SOURCES],
                  describe: "Lesson source",
                })
                .option("supersedes", {
                  type: "string",
                  describe: "ID of lesson this supersedes",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read content from stdin",
                })
                .conflicts("content", "stdin")
                .check((argv) => {
                  if (!argv.content && !argv.stdin) {
                    throw new Error(
                      "Specify either --content or --stdin",
                    );
                  }
                  return true;
                }),
              { tags: { ...SPLIT_LIST, describe: "Tags for the lesson" } },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            try {
              let content: string;
              if (argv.stdin) {
                content = await readStdinContent();
              } else {
                content = argv.content as string;
              }
              const result = await runBoardWrite(argv, format, async () => handleLessonCreate(
                {
                  title: argv.title as string,
                  content,
                  context: argv.context as string,
                  source: argv.source as string,
                  tags: argv.tags as string[] | undefined,
                  supersedes: argv.supersedes as string | undefined ?? null,
                },
                format,
                root,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update a lesson",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Lesson ID (e.g. L-001)",
                })
                .option("title", {
                  type: "string",
                  describe: "New title",
                })
                .option("content", {
                  type: "string",
                  describe: "New content",
                })
                .option("context", {
                  type: "string",
                  describe: "New context",
                })
                .option("clear-tags", {
                  type: "boolean",
                  describe: "Clear all tags",
                })
                .option("status", {
                  type: "string",
                  choices: [...LESSON_STATUSES],
                  describe: "New status",
                })
                .option("stdin", {
                  type: "boolean",
                  describe: "Read content from stdin",
                })
                .conflicts("content", "stdin")
                .conflicts("tags", "clear-tags"),
              {
                tags: {
                  ...SPLIT_LIST,
                  describe: "New tags (replaces existing)",
                  requireValue: "Use --clear-tags to clear tags.",
                },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseLessonId(argv.id as string);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            let content: string | undefined;
            if (argv.stdin) {
              content = await readStdinContent();
            } else {
              content = argv.content as string | undefined;
            }

            try {
              const result = await runBoardWrite(argv, format, async () => handleLessonUpdate(
                id,
                {
                  title: argv.title as string | undefined,
                  content,
                  context: argv.context as string | undefined,
                  tags: argv.tags as string[] | undefined,
                  clearTags: argv["clear-tags"] as boolean | undefined,
                  status: argv.status as string | undefined,
                },
                format,
                root,
              ));
              writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "reinforce <id>",
          "Reinforce a lesson -- increment reinforcement count and update lastValidated",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2.positional("id", {
                type: "string",
                demandOption: true,
                describe: "Lesson ID (e.g. L-001)",
              }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseLessonId(argv.id as string);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleLessonReinforce(id, format, root));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a lesson",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Lesson ID (e.g. L-001)",
                })
                .option("hard", {
                  type: "boolean",
                  default: false,
                  describe: "Force physical removal (skip soft delete in team mode)",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseLessonId(argv.id as string);
            const hard = argv.hard as boolean;
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
                format,
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const { resolveAndNormalizeLessonRef, RefResolutionError } = await import("../core/ref-normalization.js");
              const { loadProject } = await import("../core/index.js");
              const { state } = await loadProject(root);
              const resolvedId = resolveAndNormalizeLessonRef(state, id);
              const lesson = state.lessonByID(resolvedId);
              const result = await runBoardWrite(argv, format, async () => handleLessonDelete(resolvedId, format, root, hard, lesson?.displayId ?? resolvedId));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { RefResolutionError } = await import("../core/ref-normalization.js");
              if (err instanceof RefResolutionError) {
                // ISS-805: an ambiguous ref is caller input, not a project
                // conflict; classify it invalid_input, keep missing as not_found.
                const code = err.reason === "missing" ? "not_found" : "invalid_input";
                writeOutput(formatError(code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(1, "Specify a lesson subcommand: list, get, digest, create, update, reinforce, delete"),
  );
}

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------

export function registerNodeCommand(yargs: Argv): Argv {
  return yargs.command(
    "node",
    "Federation node operations",
    (y) =>
      y
        .command(
          "add <name>",
          "Add a node to orchestrator config",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .positional("name", {
                  type: "string",
                  demandOption: true,
                  describe: "Node name (lowercase alphanumeric, hyphens, underscores)",
                })
                .option("path", {
                  type: "string",
                  demandOption: true,
                  describe: "Path to node directory (absolute or ~/relative)",
                })
                .option("stack", {
                  type: "string",
                  describe: "Tech stack (e.g. npm, swift-spm, cargo)",
                })
                .option("role", {
                  type: "string",
                  describe: "Human-readable role description",
                })
                .option("kind", {
                  type: "string",
                  describe: "Node kind (e.g. library, service, app)",
                })
                .option("summary", {
                  type: "string",
                  describe: "One-line status summary",
                }),
              {
                "depends-on": { ...LEGACY_SPLIT_LIST, describe: "Node names this depends on" },
                link: {
                  ...LITERAL_KEEP_BLANK,
                  describe: "Runtime link (node or node:via_desc)",
                },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const links = (argv.link as string[] | undefined)?.map((l) => {
                const colonIdx = l.indexOf(":");
                if (colonIdx === -1) return { to: l };
                return { to: l.slice(0, colonIdx), via: l.slice(colonIdx + 1) };
              });
              const result = await runBoardWrite(argv, format, async () => handleNodeAdd(
                {
                  name: argv.name as string,
                  path: argv.path as string,
                  stack: argv.stack as string | undefined,
                  role: argv.role as string | undefined,
                  kind: argv.kind as string | undefined,
                  summary: argv.summary as string | undefined,
                  dependsOn: argv["depends-on"] as string[] | undefined,
                  links,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "link [orchestrator]",
          "Record which orchestrator THIS project belongs to (run from the node)",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2.positional("orchestrator", {
                type: "string",
                describe: "Path to the orchestrator project (defaults to the recorded one, revalidated)",
              }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleNodeLink(
                // T-520: resolved against the SHELL's directory, not the
                // project root -- see `resolveOrchestratorArg`.
                { orchestrator: resolveOrchestratorArg(argv.orchestrator, process.cwd()) },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "remove <name>",
          "Remove a node from orchestrator config",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("name", {
                  type: "string",
                  demandOption: true,
                  describe: "Node name to remove",
                })
                .option("force", {
                  type: "boolean",
                  default: false,
                  describe: "Remove even with dangling references",
                })
                .option("prune", {
                  type: "boolean",
                  default: false,
                  describe: "Remove and clean dependsOn references in other nodes",
                }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await runBoardWrite(argv, format, async () => handleNodeRemove(
                argv.name as string,
                {
                  force: argv.force as boolean,
                  prune: argv.prune as boolean,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <name>",
          "Update an existing node's metadata",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(y2
                .positional("name", {
                  type: "string",
                  demandOption: true,
                  describe: "Node name to update",
                })
                .option("path", {
                  type: "string",
                  describe: "New path to node directory",
                })
                .option("stack", {
                  type: "string",
                  describe: "New tech stack",
                })
                .option("role", {
                  type: "string",
                  describe: "New role description",
                })
                .option("kind", {
                  type: "string",
                  describe: "New node kind",
                })
                .option("summary", {
                  type: "string",
                  describe: "New status summary",
                })
                .option("clear-depends-on", {
                  type: "boolean",
                  default: false,
                  describe: "Clear all dependencies",
                })
                .option("clear-links", {
                  type: "boolean",
                  default: false,
                  describe: "Clear all runtime links",
                }),
              {
                "depends-on": { ...LEGACY_SPLIT_LIST, describe: "Replace dependsOn list" },
                link: {
                  ...LITERAL_KEEP_BLANK,
                  describe: "Replace links (node or node:via_desc)",
                },
              },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format), format);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const links = (argv.link as string[] | undefined)?.map((l) => {
                const colonIdx = l.indexOf(":");
                if (colonIdx === -1) return { to: l };
                return { to: l.slice(0, colonIdx), via: l.slice(colonIdx + 1) };
              });
              const result = await runBoardWrite(argv, format, async () => handleNodeUpdate(
                argv.name as string,
                {
                  path: argv.path as string | undefined,
                  stack: argv.stack as string | undefined,
                  role: argv.role as string | undefined,
                  kind: argv.kind as string | undefined,
                  summary: argv.summary as string | undefined,
                  dependsOn: argv["depends-on"] as string[] | undefined,
                  clearDependsOn: argv["clear-depends-on"] as boolean,
                  links,
                  clearLinks: argv["clear-links"] as boolean,
                },
                format,
                root,
              ));
              writeOutput(result.output, format);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format), format);
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "list",
          "List configured nodes",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handleNodeList);
          },
        )
        .demandCommand(1, "Specify a node subcommand: add, remove, update, list")
        .strict(),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

/**
 * T-502: `storybloq health`. Runs with OR WITHOUT a `.story/` project, so a
 * missing root is not an error here the way it is for `selftest`: the
 * no-project case is exactly when a newcomer most needs the answer.
 *
 * `projectDir` is `process.cwd()`, the invocation directory, because that is
 * where Claude Code resolves project settings and `.mcp.json` from. The
 * discovered ledger root supplies config only.
 */
export function registerHealthCommand(yargs: Argv): Argv {
  return yargs.command(
    "health",
    "Check the tooling around this project: auto-compact window, CLI version, Codex review bridge, /story skill, cross-session messaging",
    (y) =>
      arrayOption(
        addFormatOption(y).option("refresh", {
          type: "boolean",
          default: false,
          describe: "Force the registry lookup even when the 24 hour cache is fresh",
        }),
        "only",
        {
          // Comma-split so `--only cli-version,codex-bridge` works the way a
          // user expects; a bare `--only` is rejected, because omitting the
          // flag is already the way to run everything and a bare flag that
          // silently meant "all" would hide a typo'd value.
          comma: "split",
          emptyAfterSplit: "reject",
          empty: "drop",
          trim: "always",
          requireValue: "Pass at least one check id, or omit --only to run them all.",
          describe: "Run only these checks (usage-window, cli-version, codex-bridge, skill-version, cross-session-inbound, hook-duplicates)",
        },
      ),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const { HEALTH_CHECK_IDS } = await import("../core/health/types.js");
      const requested: string[] = (Array.isArray(argv.only) ? (argv.only as unknown[]) : [])
        .filter((v): v is string => typeof v === "string");
      const unknown = requested.filter((id) => !(HEALTH_CHECK_IDS as readonly string[]).includes(id));
      if (unknown.length > 0) {
        writeOutput(
          formatError(
            "invalid_input",
            `Unknown check id: ${unknown.join(", ")}. Valid ids: ${HEALTH_CHECK_IDS.join(", ")}.`,
            format,
          ),
          format,
        );
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      const projectDir = process.cwd();
      const ledgerRoot = (await import("../core/project-root-discovery.js")).discoverProjectRoot() ?? null;
      const { handleHealth } = await import("./commands/health.js");
      const result = await handleHealth({ ledgerRoot, projectDir }, format, {
        ...(requested.length > 0 ? { only: requested as never } : {}),
        refresh: argv.refresh === true,
      });
      writeOutput(result.output, format);
      // Deliberately always OK: a tooling report is information, not a gate,
      // so scripts and hooks can call it without arming a failure.
      process.exitCode = ExitCode.OK;
    },
  );
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

export function registerSelftestCommand(yargs: Argv): Argv {
  return yargs.command(
    "selftest",
    "Run integration smoke test -- create/update/delete cycle across all entity types",
    (y) => addFormatOption(y),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const root = (
        await import("../core/project-root-discovery.js")
      ).discoverProjectRoot();
      if (!root) {
        writeOutput(
          formatError("not_found", "No .story/ project found.", format),
          format,
        );
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      try {
        const result = await handleSelftest(root, format);
        writeOutput(result.output, format);
        process.exitCode = result.exitCode ?? ExitCode.OK;
      } catch (err: unknown) {
        if (err instanceof CliValidationError) {
          writeOutput(formatError(err.code, err.message, format), format);
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const { ProjectLoaderError } = await import("../core/errors.js");
        if (err instanceof ProjectLoaderError) {
          writeOutput(formatError(err.code, err.message, format), format);
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, format), format);
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// codex-review
// ---------------------------------------------------------------------------

export function registerCodexReviewCommand(yargs: Argv): Argv {
  return yargs.command(
    "codex-review <kind>",
    "Run native Codex review and emit an autonomous guide report",
    (y) =>
      y
        .positional("kind", {
          type: "string",
          choices: ["plan", "code"] as const,
          demandOption: true,
          describe: "Review kind",
        })
        .option("session", {
          type: "string",
          demandOption: true,
          describe: "Storybloq session ID",
        })
        .option("format", {
          type: "string",
          default: "guide-report",
          choices: ["guide-report"] as const,
          describe: "Output format",
        }),
    async (argv) => {
      try {
        const { handleCodexReview } = await import("./commands/codex-review.js");
        const result = await handleCodexReview({
          kind: argv.kind as CodexReviewKind,
          sessionId: argv.session as string,
          format: "guide-report",
        });
        writeOutput(JSON.stringify(result, null, 2), "json");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, "json"), "json");
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export function registerUpdateCommand(yargs: Argv): Argv {
  return yargs.command(
    "update",
    "Install the newest storybloq, re-run setup for your AI clients, and say when to restart",
    (y) =>
      y.option("client", {
        type: "string",
        default: "all",
        choices: ["claude", "codex", "all"] as const,
        description: "Client to re-run setup for after the install",
      }),
    async (argv) => {
      const { handleUpdate } = await import("./commands/update.js");
      await handleUpdate({ client: argv.client as SetupClient });
    },
  );
}

export function registerSetupCommand(yargs: Argv): Argv {
  return yargs.command(
    "setup",
    "Install Storybloq skill, MCP, and hooks for AI clients",
    (y) =>
      y
        .option("client", {
          type: "string",
          default: "all",
          choices: ["claude", "codex", "all"] as const,
          description: "Client to configure",
        })
        .option("skip-hooks", {
          type: "boolean",
          default: false,
          description: "Skip hook registration",
        })
        .option("skip-skill", {
          type: "boolean",
          default: false,
          description:
            "Skip the Codex skill-directory copy (--client codex/all only) -- for an install already managed by the storybloq Codex marketplace plugin",
        }),
    async (argv) => {
      const { handleSetup } = await import("./commands/setup-skill.js");
      await handleSetup({
        client: argv.client as SetupClient,
        skipHooks: argv["skip-hooks"] === true,
        skipSkill: argv["skip-skill"] === true,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// setup-skill
// ---------------------------------------------------------------------------

export function registerSetupSkillCommand(yargs: Argv): Argv {
  return yargs.command(
    "setup-skill",
    "Compatibility alias for `storybloq setup --client claude`",
    (y) =>
      y.option("skip-hooks", {
        type: "boolean",
        default: false,
        description: "Skip hook registration",
      }),
    async (argv) => {
      const { handleSetupSkill } = await import("./commands/setup-skill.js");
      await handleSetupSkill({ skipHooks: argv["skip-hooks"] === true });
    },
  );
}

// ---------------------------------------------------------------------------
// hook-status
// ---------------------------------------------------------------------------

export function registerHookStatusCommand(yargs: Argv): Argv {
  return yargs.command(
    "hook-status",
    false as unknown as string, // hidden -- machine-facing, not shown in --help
    (y) => y.option("client", {
      type: "string",
      choices: ["claude", "codex"] as const,
      default: "claude" as const,
    }),
    async (argv) => {
      const { handleHookStatus } = await import("./commands/hook-status.js");
      await handleHookStatus({ client: argv.client as "claude" | "codex" });
    },
  );
}

// ---------------------------------------------------------------------------
// hook-bus-tool (T-427: tool-boundary Bus delivery)
// ---------------------------------------------------------------------------

export function registerHookBusToolCommand(yargs: Argv): Argv {
  return yargs.command(
    "hook-bus-tool",
    false as unknown as string, // hidden -- machine-facing PostToolUse hook
    (y) => y,
    async () => {
      const { handleBusToolHook } = await import("./commands/hook-status.js");
      await handleBusToolHook();
    },
  );
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function registerConfigCommand(yargs: Argv): Argv {
  return yargs.command(
    "config",
    "Manage project configuration",
    (y) =>
      y.command(
        "set-overrides",
        "Set or clear recipe overrides in config.json",
        (y: Argv) => addCommitOption(((y2) =>
          addFormatOption(y2
            .option("json", {
              type: "string",
              describe: "JSON object to merge into recipeOverrides",
            })
            .option("clear", {
              type: "boolean",
              describe: "Remove recipeOverrides entirely (reset to defaults)",
            })
            .option("deep", {
              type: "boolean",
              describe: "Deep-merge --json instead of shallow: objects recurse, null deletes at any depth, arrays and scalars replace",
            })))(y)),
        async (argv) => {
          const { handleConfigSetOverrides } = await import("./commands/config-update.js");
          const { writeOutput } = await import("./run.js");
          const format = argv.format as "json" | "md";
          try {
            const result = await runBoardWrite(argv, format, async () => handleConfigSetOverrides(
              process.cwd(),
              format,
              {
                json: argv.json as string | undefined,
                clear: argv.clear === true,
                deep: argv.deep === true,
              },
            ));
            writeOutput(result.output, format);
            if (result.errorCode) process.exitCode = 1;
          } catch (err: unknown) {
            const { formatError, ExitCode } = await import("../core/output-formatter.js");
            const { ProjectLoaderError } = await import("../core/errors.js");
            if (err instanceof ProjectLoaderError) {
              writeOutput(formatError(err.code, err.message, format), format);
            } else {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
            }
            process.exitCode = ExitCode.USER_ERROR;
          }
        },
      )
      .command(
        "set-federation",
        "Set federation settings (orchestrator only)",
        (y: Argv) => addCommitOption(((y2) =>
          addFormatOption(y2
            .option("allow-node-writes", {
              type: "boolean",
              describe: "Allow orchestrator MCP tools to write to node .story/ directories",
            })))(y)),
        async (argv) => {
          const { handleConfigSetFederation } = await import("./commands/config-update.js");
          const { writeOutput } = await import("./run.js");
          const format = argv.format as "json" | "md";
          const root = (
            await import("../core/project-root-discovery.js")
          ).discoverProjectRoot();
          if (!root) {
            writeOutput(formatError("not_found", "No .story/ project found.", format), format);
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          try {
            const result = await runBoardWrite(argv, format, async () => handleConfigSetFederation(root, format, {
              allowNodeWrites: argv["allow-node-writes"] as boolean | undefined,
            }));
            writeOutput(result.output, format);
            if (result.errorCode) process.exitCode = 1;
          } catch (err: unknown) {
            const { ProjectLoaderError } = await import("../core/errors.js");
            if (err instanceof ProjectLoaderError) {
              writeOutput(formatError(err.code, err.message, format), format);
            } else {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format), format);
            }
            process.exitCode = ExitCode.USER_ERROR;
          }
        },
      )
      .demandCommand(1, "Specify a config subcommand. Available: set-overrides, set-federation"),
  );
}

// ---------------------------------------------------------------------------
// session (ISS-032: hook-driven compaction)
// ---------------------------------------------------------------------------

export function registerSessionCommand(yargs: Argv): Argv {
  return yargs.command(
    "session",
    false as unknown as string, // hidden -- machine-facing
    (y) =>
      y
        .command(
          "compact-prepare",
          "Prepare session for compaction (PreCompact hook)",
          (y2) =>
            y2.option("client", {
              type: "string",
              choices: ["claude", "codex"] as const,
              default: "claude" as const,
              describe: "AI client invoking the PreCompact hook",
            }),
          async (argv) => {
            const { handleSessionCompactPrepare, readHookStdinContext } = await import("./commands/session-compact.js");
            const hookContext = await readHookStdinContext(process.stdin);
            await handleSessionCompactPrepare({
              client: argv.client as "claude" | "codex",
              clientTaskId: hookContext.sessionId,
              cwd: hookContext.cwd,
              transcriptPath: hookContext.transcriptPath,
              trigger: hookContext.trigger,
              subagent: hookContext.subagent,
            });
          },
        )
        .command(
          "resume-prompt",
          "Output resume instruction after compaction (SessionStart hook)",
          (y2) =>
            y2.option("codex-hook-json", {
              type: "boolean",
              default: false,
              describe: "Emit Codex SessionStart hook JSON instead of plain text",
            }),
          async (argv) => {
            try {
              const { handleSessionResumePrompt, readHookStdinContext } = await import("./commands/session-compact.js");
              const hookContext = await readHookStdinContext(process.stdin);
              await handleSessionResumePrompt({
                codexHookJson: argv["codex-hook-json"] === true,
                source: hookContext.source,
                clientTaskId: hookContext.sessionId,
                cwd: hookContext.cwd,
                transcriptPath: hookContext.transcriptPath,
                subagent: hookContext.subagent,
              });
            } catch (err) {
              process.stderr.write(
                `[storybloq] resume-prompt failed: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
        )
        .command(
          "intel",
          "T-499: current context usage, expected auto-compact point and its provenance, session facts (works without .story/)",
          (y2) =>
            y2
              .option("format", { type: "string", choices: ["md", "json"] as const, default: "md" as const, describe: "Output format" })
              .option("session-id", { type: "string", describe: "Inspect another session read-only (never captures, persists or classifies)" })
              .option("transcript", { type: "string", describe: "Explicit transcript path, read-only: must be ~/.claude/projects/<project>/<sessionId>.jsonl, a regular file, not a symlink; a refusal names the rule that failed" })
              .option("caller-model", { type: "string", describe: "Cross-check against the transcript's last model; a mismatch is reported, never overridden" })
              .option("full", { type: "boolean", default: false, describe: "Stream the whole transcript (64 MiB budget) for session-wide counts" })
              .option("client-task-id", { type: "string", describe: "Explicit caller identity, if not resolvable from the session" }),
          async (argv) => {
            const { handleSessionIntel } = await import("./commands/session-intel.js");
            try {
              const result = handleSessionIntel({
                format: argv.format as "json" | "md",
                sessionId: argv["session-id"] as string | undefined,
                transcript: argv.transcript as string | undefined,
                callerModel: argv["caller-model"] as string | undefined,
                full: argv.full === true,
                clientTaskId: argv["client-task-id"] as string | undefined,
              });
              // Project-free template: every byte through writeOutput.
              writeOutput(result.output, outputFormatOf(argv.format));
              if (result.errorCode) process.exitCode = 1;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(argv.format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message, outputFormatOf(argv.format));
              process.exitCode = 1;
            }
          },
        )
        .command(
          "intel-start",
          "T-499: capture the auto-compact setting for this process era (SessionStart hook: startup|resume|clear|compact)",
          (y2) =>
            y2.option("client", {
              type: "string",
              choices: ["claude", "codex"] as const,
              default: "claude" as const,
              describe: "AI client invoking the SessionStart hook",
            }),
          async (argv) => {
            try {
              const { readHookStdinContext } = await import("./commands/session-compact.js");
              const { handleSessionIntelStart } = await import("./commands/session-intel.js");
              const hookContext = await readHookStdinContext(process.stdin);
              handleSessionIntelStart({
                client: argv.client as "claude" | "codex",
                source: hookContext.source,
                sessionId: hookContext.sessionId,
                cwd: hookContext.cwd,
                transcriptPath: hookContext.transcriptPath,
                subagent: hookContext.subagent,
              });
              // T-528: awaited, never detached; one hash pass, and a structural
              // write with no git only when the ledger moved.
              let projectRoot: string | null = null;
              try {
                projectRoot = (await import("../core/project-root-discovery.js")).discoverProjectRoot(hookContext.cwd ?? process.cwd());
              } catch {
                projectRoot = null;
              }
              if (projectRoot) await (await import("./commands/projection.js")).refreshProjectionAtSessionStart(projectRoot);
            } catch (err) {
              // Hook contract: always exit 0, never block a session start.
              process.stderr.write(
                `[storybloq] intel-start failed: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
        )
        .command(
          "intel-prompt",
          "T-499: synchronous context-pressure sample; emits additionalContext at imperative (UserPromptSubmit hook)",
          (y2) =>
            y2.option("client", {
              type: "string",
              choices: ["claude", "codex"] as const,
              default: "claude" as const,
              describe: "AI client invoking the UserPromptSubmit hook",
            }),
          async (argv) => {
            try {
              const { readHookStdinContext } = await import("./commands/session-compact.js");
              const { handleSessionIntelPrompt } = await import("./commands/session-intel.js");
              // The payload carries the whole prompt: a 1 MiB cap, and the
              // prompt field itself is never read.
              const hookContext = await readHookStdinContext(process.stdin, 200, { maxBytes: 1024 * 1024 });
              const outcome = handleSessionIntelPrompt({
                client: argv.client as "claude" | "codex",
                sessionId: hookContext.sessionId,
                cwd: hookContext.cwd,
                transcriptPath: hookContext.transcriptPath,
              });
              if (outcome.output !== null) process.stdout.write(outcome.output + "\n");
            } catch (err) {
              // Hook contract: always exit 0, never block a prompt.
              process.stderr.write(
                `[storybloq] intel-prompt failed: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
        )
        .command(
          "limit-stop",
          // T-534 tombstone, hidden: installs that still carry the retired
          // StopFailure hook land here and only run the retirement.
          false as unknown as string,
          (y2) => y2,
          async () => {
            try {
              const { handleSessionLimitStop, readHookStdinContext } = await import("./commands/session-compact.js");
              // Drain the hook payload; nothing in it is used.
              await readHookStdinContext(process.stdin);
              await handleSessionLimitStop();
            } catch (err) {
              // Hook contract: always exit 0; the session is already stopped.
              process.stderr.write(
                `[storybloq] limit-stop failed: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
        )
        .command(
          "clear-compact [sessionId]",
          "Clear stale compact marker (admin)",
          (y2) =>
            y2
              .positional("sessionId", {
                type: "string",
                describe: "Session ID (optional -- scans for compactPending session if omitted)",
              })
              .option("force", {
                type: "boolean",
                default: false,
                describe: "Clear a FINALIZE park left by the retired usage-limit auto-resume while git is unavailable (recovers to IMPLEMENT)",
              }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionClearCompact } = await import("./commands/session-compact.js");
            try {
              const result = await handleSessionClearCompact(root, argv.sessionId as string | undefined, {
                force: argv.force === true,
              });
              process.stdout.write(result + "\n");
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "stop [sessionId]",
          "Stop an active session (admin)",
          (y2) =>
            y2.positional("sessionId", {
              type: "string",
              describe: "Session ID (optional -- stops active session if omitted)",
            }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionStop } = await import("./commands/session-compact.js");
            try {
              const result = await handleSessionStop(root, argv.sessionId as string | undefined);
              process.stdout.write(result + "\n");
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "list",
          "List sessions on disk (admin)",
          (y2) =>
            y2
              .option("status", {
                type: "string",
                describe: "Filter by status",
                choices: ["active", "completed", "superseded", "all"] as const,
                default: "all",
              })
              .option("format", {
                type: "string",
                describe: "Output format",
                choices: ["text", "json"] as const,
                default: "text",
              })
              // ISS-910: this command is EXEMPT from the shared md/json
              // envelope axis -- its text/json contract predates it and was
              // deliberately hardened (ISS-897). Documented here instead.
              .epilogue(
                'JSON output (--format json) emits this command\'s own top-level shape {"sessions", "damaged"} -- ' +
                "NOT the shared {\"version\": 1, \"data\"} envelope other commands use -- and --raw is not defined here. " +
                "The text/json axis predates the shared envelope and its raw contract is preserved deliberately.",
              ),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionList } = await import("./commands/session.js");
            try {
              const result = await handleSessionList(root, {
                status: argv.status as "active" | "completed" | "superseded" | "all",
                format: argv.format as "text" | "json",
              });
              process.stdout.write(result + "\n");
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "show <sessionId>",
          "Show details of a session (admin)",
          (y2) =>
            y2
              .positional("sessionId", {
                type: "string",
                describe: "Session ID or unique prefix",
                demandOption: true,
              })
              .option("format", {
                type: "string",
                describe: "Output format",
                choices: ["text", "json"] as const,
                default: "text",
              })
              // ISS-910: same exemption as `session list` -- own shape, no envelope.
              .epilogue(
                'JSON output (--format json) emits this command\'s own top-level shape {"state", "recentEvents"} -- ' +
                "NOT the shared {\"version\": 1, \"data\"} envelope other commands use -- and --raw is not defined here. " +
                "The text/json axis predates the shared envelope and its raw contract is preserved deliberately.",
              )
              .option("events", {
                type: "number",
                describe: "Number of recent events to include (non-negative integer)",
                default: 10,
              })
              .check((argv) => {
                const n = argv.events as number;
                if (!Number.isInteger(n) || n < 0) {
                  throw new Error("--events must be a non-negative integer");
                }
                return true;
              }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionShow } = await import("./commands/session.js");
            try {
              const result = await handleSessionShow(root, argv.sessionId as string, {
                format: argv.format as "text" | "json",
                events: argv.events as number,
              });
              process.stdout.write(result + "\n");
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "repair [sessionId]",
          "Supersede orphaned sessions (admin)",
          (y2) =>
            y2
              .positional("sessionId", {
                type: "string",
                describe: "Session ID or unique prefix (optional -- scans for orphans if omitted)",
              })
              .option("dry-run", {
                type: "boolean",
                describe: "Report candidates without writing",
                default: false,
              })
              .option("all", {
                type: "boolean",
                describe: "Include stale sessions that don't match the finished-orphan signature",
                default: false,
              })
              .option("yes", {
                type: "boolean",
                describe: "Skip interactive confirmation",
                default: false,
              }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionRepair } = await import("./commands/session.js");
            try {
              const result = await handleSessionRepair(root, {
                selector: argv.sessionId as string | undefined,
                dryRun: argv["dry-run"] as boolean,
                all: argv.all as boolean,
                yes: argv.yes as boolean,
                stdin: process.stdin,
                stdout: process.stdout,
              });
              process.stdout.write(result + "\n");
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "delete <sessionId>",
          "Delete a session directory (admin, destructive)",
          (y2) =>
            y2
              .positional("sessionId", {
                type: "string",
                describe: "Session ID or unique prefix",
                demandOption: true,
              })
              .option("yes", {
                type: "boolean",
                describe: "Required: confirm destructive removal",
                default: false,
              }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionDelete } = await import("./commands/session.js");
            try {
              const result = await handleSessionDelete(root, argv.sessionId as string, {
                yes: argv.yes as boolean,
              });
              process.stdout.write(result + "\n");
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "health [sessionId]",
          "Derive and display session health state",
          (y2) =>
            y2.positional("sessionId", {
              type: "string",
              describe: "Session ID (optional -- uses active session if omitted)",
            }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionHealth } = await import("./commands/session-health.js");
            try {
              await handleSessionHealth(root, argv.sessionId as string | undefined);
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "watch [sessionId]",
          "Stream session health state changes",
          (y2) =>
            y2
              .positional("sessionId", {
                type: "string",
                describe: "Session ID (optional -- uses active session if omitted)",
              })
              .option("events", {
                type: "boolean",
                describe: "Emit raw JSON events (one per line)",
                default: false,
              })
              .option("quiet", {
                type: "boolean",
                describe: "Only emit on health state transitions",
                default: false,
              }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { handleSessionWatch } = await import("./commands/session-watch.js");
            try {
              await handleSessionWatch(root, argv.sessionId as string | undefined, {
                events: argv.events as boolean,
                quiet: argv.quiet as boolean,
              });
            } catch (err: unknown) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exitCode = 1;
            }
          },
        )
        .command(
          "milestone <kind>",
          "Report a self-described work milestone for presence display (duet/arrangement sessions)",
          (y2) =>
            y2
              .positional("kind", {
                type: "string",
                choices: ["implementing", "gate-hold", "blocked-external", "reviewing"] as const,
                demandOption: true,
                describe: "What this session is doing right now",
              })
              .option("gate-name", {
                type: "string",
                describe: "Required for kind=gate-hold: which gate is being held at",
              })
              .option("note", {
                type: "string",
                describe: "Optional free-text note",
              })
              .option("client-task-id", {
                type: "string",
                describe: "Explicit caller identity, if not resolvable from the session",
              })
              .option("format", {
                type: "string",
                choices: ["text", "json"] as const,
                default: "text",
              }),
          async (argv) => {
            const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
            const root = discoverProjectRoot();
            if (!root) {
              process.stderr.write("No .story/ project found.\n");
              process.exitCode = 1;
              return;
            }
            const { MilestoneWriteSchema, handleSessionMilestone } = await import("./commands/session-milestone.js");
            const rawInput = {
              kind: argv.kind,
              ...(argv["gate-name"] !== undefined ? { gateName: argv["gate-name"] } : {}),
              ...(argv.note !== undefined ? { note: argv.note } : {}),
            };
            const parsed = MilestoneWriteSchema.safeParse(rawInput);
            if (!parsed.success) {
              process.stderr.write(`Invalid milestone input: ${parsed.error.issues.map((i) => i.message).join("; ")}\n`);
              process.exitCode = 1;
              return;
            }
            const result = handleSessionMilestone(root, parsed.data, argv["client-task-id"] as string | undefined);
            if (argv.format === "json") {
              process.stdout.write(JSON.stringify(result, null, 2) + "\n");
            } else if (result.ok) {
              process.stdout.write(`Milestone recorded: ${result.kind} at ${result.at}\n`);
            } else {
              process.stderr.write(`${result.message}\n`);
            }
            if (!result.ok) process.exitCode = 1;
          },
        )
        .demandCommand(
          1,
          "Specify a session subcommand: compact-prepare, resume-prompt, intel, intel-start, intel-prompt, clear-compact, stop, list, show, repair, delete, health, watch, milestone",
        )
        .strict(),
    () => {},
  );
}

// MARK: - Roster Command (T-507)

/**
 * `storybloq roster start|heartbeat|end|list`. The three writes are the Claude
 * Code function-hooks path (a Mod would run them through
 * `$.process.run` with `--stdin --format json`); they never load project
 * state and always answer with one JSON envelope on stdout, `no_project`
 * included. `list` is the human and MCP read, Bus merged, terminal seats
 * hidden unless `--all`.
 */
export const ROSTER_BODY_MAX_BYTES = 4096;

export function registerRosterCommand(yargs: Argv): Argv {
  const write = (kind: "start" | "heartbeat" | "end", description: string) =>
    (y: Argv) =>
      y.command(
        kind,
        description,
        (y2) => {
          // Each operation exposes exactly the fields its strict body schema
          // accepts (a flag the schema rejects would answer invalid_input).
          let y3 = y2
            .option("stdin", { type: "boolean", default: false, describe: `Read the JSON body from stdin (${ROSTER_BODY_MAX_BYTES} bytes max)` })
            .option("client-task-id", { type: "string", describe: "Seat identity; default: CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID" })
            .option("agent-id", { type: "string", describe: "Subagent id for a subagent seat" });
          if (kind === "start") {
            y3 = y3
              .option("session-id", { type: "string", describe: "The client session id (default: the task id)" })
              .option("description", { type: "string", describe: "A short label (200 bytes)" });
          } else {
            y3 = y3.option("generation", { type: "number", describe: "The generation from the start result" });
          }
          if (kind === "end") {
            y3 = y3.option("state", { type: "string", choices: ["completed", "failed", "killed", "detached"] as const, describe: "The terminal state" });
          }
          return y3.option("format", { type: "string", choices: ["json"] as const, default: "json", describe: "JSON only" });
        },
        async (argv) => {
          const { handleRosterWrite, parseRosterBody, identityFallbackFromEnvironment } = await import("./commands/roster.js");
          const { ExitCode, errorEnvelope } = await import("../core/output-formatter.js");
          const answer = (output: string, exitCode: number): void => {
            process.stdout.write(output + "\n");
            if (exitCode !== 0) process.exitCode = exitCode;
          };
          let body: Record<string, unknown> = {};
          if (argv.stdin) {
            // Bounded read: the body's fields are byte-capped, so the whole
            // body is too; past the ceiling the read stops and the answer is
            // invalid_input rather than an unbounded buffer.
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of process.stdin) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              total += buf.length;
              if (total > ROSTER_BODY_MAX_BYTES) {
                answer(JSON.stringify(errorEnvelope("invalid_input", `roster body exceeds ${ROSTER_BODY_MAX_BYTES} bytes`), null, 2), ExitCode.USER_ERROR);
                return;
              }
              chunks.push(buf);
            }
            const parsed = parseRosterBody(Buffer.concat(chunks).toString("utf-8"));
            if (!parsed.ok) {
              answer(JSON.stringify(errorEnvelope("invalid_input", parsed.message), null, 2), ExitCode.USER_ERROR);
              return;
            }
            body = parsed.body;
          }
          // Flags fill in what the body left out; the body wins.
          const a = argv as Record<string, unknown>;
          const flagged: Record<string, unknown> = {
            ...(a["client-task-id"] !== undefined ? { clientTaskId: a["client-task-id"] } : {}),
            ...(a["agent-id"] !== undefined ? { agentId: a["agent-id"] } : {}),
            ...(a["session-id"] !== undefined ? { sessionId: a["session-id"] } : {}),
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.generation !== undefined ? { generation: a.generation } : {}),
            ...(a.state !== undefined ? { state: a.state } : {}),
          };
          const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
          // `null` (no ledger above the cwd) is the only no_project answer. A
          // throw is an unreadable .story/ and is said as io_error, so a caller
          // never caches "no project here" over a permissions failure.
          let root: string | null;
          try {
            root = discoverProjectRoot();
          } catch (err) {
            answer(JSON.stringify(errorEnvelope("io_error", err instanceof Error ? err.message : String(err)), null, 2), ExitCode.USER_ERROR);
            return;
          }
          const result = handleRosterWrite(root, kind, { ...flagged, ...body }, identityFallbackFromEnvironment());
          answer(result.output, result.exitCode);
        },
      );
  return yargs.command(
    "roster",
    "Seat roster: who is working this ledger right now (T-507)",
    (y) =>
      write("start", "Start (or restart) a seat: a session or one of its subagents")(
        write("heartbeat", "Refresh a running seat's lastSeenAt")(
          write("end", "End a seat with a terminal state")(y),
        ),
      )
        .command(
          "list",
          "List seats: running by default, every seat with --all",
          (y2) =>
            addFormatOption(y2).option("all", { type: "boolean", default: false, describe: "Include terminal seats (completed/failed/killed/detached)" }),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleRosterList } = await import("./commands/roster.js");
            await runReadCommand(format, (ctx) => handleRosterList(ctx, { all: argv.all as boolean }));
          },
        )
        .demandCommand(1, "Specify a roster subcommand: start, heartbeat, end, list")
        .strict(),
    () => {},
  );
}

// MARK: - Feedback Command

export function registerFeedbackCommand(yargs: Argv): Argv {
  return yargs.command(
    "feedback [subcommand]",
    "Community feedback via GitHub Issues",
    (y) =>
      y
        .command(
          "list",
          "List community feedback",
          (sub) =>
            addFormatOption(sub
              .option("category", {
                type: "string",
                choices: ["bug", "feature", "idea"] as const,
                describe: "Filter by category",
              })),
          async (argv) => {
            const { handleFeedbackList } = await import("./commands/feedback.js");
            const result = await handleFeedbackList(
              { category: argv.category as "bug" | "feature" | "idea" | undefined },
              argv.format as "md" | "json",
            );
            // ISS-910: accepts --raw, so it prints through the seam.
            writeOutput(result.output, outputFormatOf(argv.format));
            if (result.exitCode) process.exitCode = result.exitCode;
          },
        )
        .command(
          "create",
          "Create new feedback (opens browser)",
          (sub) =>
            sub
              .option("title", {
                type: "string",
                demandOption: true,
                describe: "Feedback title",
              })
              .option("category", {
                type: "string",
                choices: ["bug", "feature", "idea"] as const,
                describe: "Feedback category",
              })
              .option("body", {
                type: "string",
                describe: "Feedback body",
              }),
          async (argv) => {
            const { handleFeedbackCreate } = await import("./commands/feedback.js");
            const result = await handleFeedbackCreate(
              argv.title as string,
              argv.category as string | undefined,
              argv.body as string | undefined,
            );
            process.stdout.write(result.output + "\n");
            if (result.exitCode) process.exitCode = result.exitCode;
          },
        )
        .command(
          "vote <number>",
          "Vote on feedback (opens browser)",
          (sub) =>
            sub.positional("number", {
              type: "number",
              demandOption: true,
              describe: "Issue number",
            }),
          async (argv) => {
            const { handleFeedbackVote } = await import("./commands/feedback.js");
            const result = await handleFeedbackVote(argv.number as number);
            process.stdout.write(result.output + "\n");
            if (result.exitCode) process.exitCode = result.exitCode;
          },
        ),
    async (argv) => {
      if (!argv.subcommand || argv.subcommand === "feedback") {
        const { handleFeedbackOpen } = await import("./commands/feedback.js");
        const result = await handleFeedbackOpen();
        process.stdout.write(result.output + "\n");
        if (result.exitCode) process.exitCode = result.exitCode;
      }
    },
  );
}

/**
 * T-523: the capability inventory surface.
 *
 * The write leaves discover the root themselves rather than going through
 * `runReadCommand`, matching `ruling create`: the catalog transaction takes
 * the project lock itself, so a wrapper that loaded the whole project first
 * would read a state it then has to discard.
 */
/**
 * PATH-VALUED FLAGS TAKE THE LITERAL-COMMA POLICY, id-valued flags split.
 *
 * `--entry`, `--surface-file` and `match --path` carry filesystem paths, and a
 * comma is a legal character in a filename. Splitting one would turn
 * `src/a,b.ts` into two pointers that name nothing, and it would do it
 * silently: a wrong entry point cannot go stale, so the inventory would keep
 * reporting `current` about a file it is not watching. `location` on issues
 * already uses LITERAL_DROP_BLANK for exactly this reason, so this follows the
 * shipped policy rather than inventing one.
 *
 * `--cli`, `--mcp-tool`, `--app`, `--ruling`, `--item`, `--term` and `check --stamp`
 * carry command names and ids whose charsets exclude a comma, so splitting
 * them is unambiguous and stays.
 */
export function registerCapabilityCommand(yargs: Argv): Argv {
  return yargs.command(
    "capability",
    "Inspect and maintain the capability inventory",
    (y) =>
      y
        .command(
          "list",
          "List capabilities with their effective status",
          (y2) =>
            addFormatOption(
              y2
                .option("status", { type: "string", choices: ["current", "review"], describe: "Filter by EFFECTIVE status, not the stored flag" })
                .option("skip-check", { type: "boolean", describe: "Skip the freshness check; statuses printed still include structural findings" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleCapabilityList(
                { status: argv.status as string | undefined, skipCheck: argv["skip-check"] as boolean | undefined },
                ctx,
              ),
            );
          },
        )
        .command(
          "get <id>",
          "Show one capability, its contract, its entry points and its findings",
          (y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Capability ID (cap-<slug>)" })
                .option("skip-check", { type: "boolean", describe: "Skip the freshness check" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleCapabilityGet(argv.id as string, { skipCheck: argv["skip-check"] as boolean | undefined }, ctx),
            );
          },
        )
        .command(
          "match",
          "Find the capabilities a task may already be covered by. Searches the INVENTORY only: no match is never evidence that no implementation exists.",
          (y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("title", { type: "string", describe: "Task title or one-line description" })
                  .option("phase", { type: "string", describe: "Phase ID whose items' capabilities should be included" }),
                { path: { ...LITERAL_DROP_BLANK, describe: "Repo-relative path the task touches (repeatable; a comma is legal in a path, so repeat the flag)" } },
              ),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleCapabilityMatch(
                {
                  paths: argv.path as string[] | undefined,
                  title: argv.title as string | undefined,
                  phaseId: argv.phase as string | undefined,
                },
                ctx,
              ),
            );
          },
        )
        .command(
          "add",
          "Add a capability. Stamps the checkpoint at HEAD, so run it when you have actually read the entry points.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("id", { type: "string", demandOption: true, describe: "Capability ID (cap-<slug>)" })
                  .option("name", { type: "string", demandOption: true, describe: "Short human name" })
                  .option("summary", { type: "string", demandOption: true, describe: "One or two sentences: what this can do" })
                  .option("contract", { type: "string", demandOption: true, describe: "What it guarantees, in the terms a caller needs" })
                  .option("example", { type: "string", describe: "One concrete invocation or call site" })
                  .option("status", { type: "string", choices: ["current", "review"], describe: "Stored status flag (default: current)" }),
                {
                  entry: { ...LITERAL_DROP_BLANK, describe: "Repo-relative entry point, file or directory (repeatable, at least one; a comma is legal in a path, so repeat the flag)" },
                  cli: { ...SPLIT_LIST, describe: "CLI command name this is reachable through (repeatable)" },
                  // Not `--mcp`: src/cli/index.ts starts the MCP server whenever
                  // that token appears anywhere in argv, so the natural name is
                  // reserved by the entry point.
                  "mcp-tool": {
                    ...SPLIT_LIST,
                    describe: "MCP tool name this is reachable through (repeatable). Not --mcp: that flag starts the MCP server, which then waits on stdin",
                  },
                  app: { ...SPLIT_LIST, describe: "Mac app surface this is reachable through (repeatable)" },
                  "surface-file": { ...LITERAL_DROP_BLANK, describe: "Tracked file that is itself the surface (repeatable; a comma is legal in a path, so repeat the flag)" },
                  ruling: { ...SPLIT_LIST, describe: "Ruling ID that decided this (repeatable)" },
                  item: { ...SPLIT_LIST, describe: "Ticket or issue ID that built this (repeatable)" },
                  term: { ...SPLIT_LIST, describe: "Glossary term ID this defines or uses (repeatable)" },
                },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) =>
              handleCapabilityAdd(capabilityWriteInput(argv), format, root), true,
            );
          },
        )
        .command(
          "update <id>",
          "Edit a capability. Never touches the checkpoint: an edit is not an inspection.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .positional("id", { type: "string", demandOption: true, describe: "Capability ID" })
                  .option("name", { type: "string", describe: "Short human name" })
                  .option("summary", { type: "string", describe: "One or two sentences: what this can do" })
                  .option("contract", { type: "string", describe: "What it guarantees" })
                  .option("example", { type: "string", describe: "One concrete invocation or call site" })
                  .option("status", { type: "string", choices: ["current", "review"], describe: "Stored status flag" }),
                {
                  entry: { ...LITERAL_DROP_BLANK, describe: "Entry points, REPLACING the current list (repeatable; a comma is legal in a path, so repeat the flag)" },
                  cli: { ...SPLIT_LIST, describe: "CLI commands, replacing the current list (repeatable)" },
                  // Not `--mcp`, for the reason given on `capability add`.
                  "mcp-tool": {
                    ...SPLIT_LIST,
                    describe: "MCP tools, replacing the current list (repeatable). Not --mcp: that flag starts the MCP server, which then waits on stdin",
                  },
                  app: { ...SPLIT_LIST, describe: "App surfaces, replacing the current list (repeatable)" },
                  "surface-file": { ...LITERAL_DROP_BLANK, describe: "Surface files, replacing the current list (repeatable; a comma is legal in a path, so repeat the flag)" },
                  ruling: { ...SPLIT_LIST, describe: "Ruling IDs, replacing the current list (repeatable)" },
                  item: { ...SPLIT_LIST, describe: "Item IDs, replacing the current list (repeatable)" },
                  term: { ...SPLIT_LIST, describe: "Term IDs, replacing the current list (repeatable)" },
                },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) =>
              handleCapabilityUpdate({ ...capabilityWriteInput(argv), id: argv.id as string }, format, root), true,
            );
          },
        )
        .command(
          "check",
          "Check every capability against HEAD, and optionally re-stamp the ones that are only stale",
          (y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("stamp-all", { type: "boolean", describe: "Re-stamp every entry whose only findings are freshness findings" })
                  .option("clear-pending", { type: "boolean", describe: "Clear the pending note in the same write as the stamp (a stamp alone is refused while a note is set)" }),
                { stamp: { ...SPLIT_LIST, describe: "Capability ID to re-stamp after re-reading it (repeatable)" } },
              ),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            // `check` needs both a root for the write and ctx.state for item
            // resolution, so it runs through the read pipeline and does its
            // write from inside the handler.
            const stamping = argv["stamp-all"] === true || ((argv.stamp as string[] | undefined) ?? []).length > 0;
            await runReadCommand(format, async (ctx) => {
              const result = await handleCapabilityCheck(
                {
                  stamp: argv.stamp as string[] | undefined,
                  stampAll: argv["stamp-all"] as boolean | undefined,
                  clearPending: argv["clear-pending"] as boolean | undefined,
                },
                format,
                ctx.root,
                ctx,
              );
              // T-528: only a stamp writes; a plain check leaves the projection alone.
              if (stamping && (result.exitCode ?? ExitCode.OK) === ExitCode.OK) {
                await (await import("./commands/projection.js")).refreshProjectionAfterWrite(ctx.root);
              }
              return result;
            });
          },
        )
        .command(
          "defer <id>",
          "Record work owed on a capability without doing it: sets a pending note and the review flag, touches nothing else, runs no check",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Capability ID" })
                .option("note", { type: "string", demandOption: true, describe: "One sentence naming the owed work" })
                .option("issue", { type: "string", describe: "Follow-up issue that owns the work (must exist)" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            // Through the read pipeline for ctx.state (the --issue lookup); the
            // write happens inside the handler, as `check` does it.
            await runReadCommand(format, async (ctx) => {
              const result = await runBoardWrite(argv, format, async () => handleCapabilityDefer(
                { id: argv.id as string, note: argv.note as string, issue: argv.issue as string | undefined },
                format,
                ctx.root,
                ctx,
              ));
              if ((result.exitCode ?? ExitCode.OK) === ExitCode.OK) {
                await (await import("./commands/projection.js")).refreshProjectionAfterWrite(ctx.root);
              }
              return result;
            });
          },
        )
        .command(
          "restore <id>",
          "Restore one capability entry to its projection at --from, refused unless it still matches its projection at --expect",
          (y: Argv) => addCommitOption(((y2) => addRestoreOptions(y2.positional("id", { type: "string", demandOption: true, describe: "Capability ID" })))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) =>
              handleCapabilityRestore({ id: argv.id as string, from: argv.from as string, expect: argv.expect as string }, format, root), true,
            );
          },
        ),
  );
}

/** `--from` and `--expect`, shared by the three restore commands (T-526, D4). */
function addRestoreOptions<T>(y: Argv<T>) {
  return addFormatOption(
    y
      .option("from", { type: "string", demandOption: true, describe: "Commit whose projection of the record is restored" })
      .option("expect", { type: "string", demandOption: true, describe: "Commit whose projection the record must still match; refused otherwise" }),
  );
}

/** Flag-to-input mapping shared by `capability add` and `capability update`. */
function capabilityWriteInput(argv: Record<string, unknown>): CapabilityWriteInput {
  return {
    id: argv.id as string,
    name: argv.name as string | undefined,
    summary: argv.summary as string | undefined,
    entryPoints: argv.entry as string[] | undefined,
    contract: argv.contract as string | undefined,
    example: argv.example as string | undefined,
    cli: argv.cli as string[] | undefined,
    mcp: argv["mcp-tool"] as string[] | undefined,
    app: argv.app as string[] | undefined,
    files: argv["surface-file"] as string[] | undefined,
    rulings: argv.ruling as string[] | undefined,
    items: argv.item as string[] | undefined,
    terms: argv.term as string[] | undefined,
    status: argv.status as string | undefined,
  };
}

/** Root discovery plus the error mapping every catalog write shares: capabilities and terms both. */
async function runCatalogWrite(
  argv: BoardWriteArgv,
  format: ReturnType<typeof parseOutputFormat>,
  run: (root: string) => Promise<{ output: string; exitCode?: number }>,
  /** T-528: the capability and term families regenerate the decisions projection after a successful write. */
  refreshProjection = false,
): Promise<void> {
  const { formatError, ExitCode } = await import("../core/output-formatter.js");
  const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
  if (!root) {
    writeOutput(formatError("not_found", "No .story/ project found.", format), format);
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  try {
    const result = await runBoardWrite(argv, format, () => run(root));
    writeOutput(result.output, format);
    process.exitCode = result.exitCode ?? ExitCode.OK;
    if (refreshProjection && process.exitCode === ExitCode.OK) {
      await (await import("./commands/projection.js")).refreshProjectionAfterWrite(root);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const { CatalogLoadError } = await import("../core/catalog.js");
    if (err instanceof CatalogLoadError) {
      writeOutput(formatError("io_error", err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const { ProjectLoaderError } = await import("../core/errors.js");
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}

/**
 * T-524: the glossary surface.
 *
 * ADVISORY, AND THE REGISTRATION SHOWS IT (G-A). `match` is a read command
 * that prints and exits; nothing here consults the glossary to decide whether
 * to accept another command's input, and no flag anywhere else in this file
 * takes a term.
 *
 * SAME COMMA POLICY AS THE INVENTORY, applied to the values this surface has.
 * `--alias` carries a word or a short phrase written by a human, and a comma
 * is legal inside one, so it takes the literal policy: splitting `hands, the
 * cheap tier` into two aliases would invent one nobody wrote and then own the
 * word. `--capability` and `--ruling` carry ids whose charsets exclude a
 * comma, so splitting them is unambiguous.
 */
export function registerTermCommand(yargs: Argv): Argv {
  return yargs.command(
    "term",
    "Read and maintain the glossary: what a word means here, and what it is not",
    (y) =>
      y
        .command(
          "list",
          "List the glossary. Advisory: nothing renames or refuses on a term.",
          (y2) =>
            addFormatOption(
              y2
                .option("core", { type: "boolean", describe: "Only the entries marked core" })
                .option("thin", { type: "boolean", describe: "Only the entries missing a distinction or a capability link" })
                .option("digest", { type: "boolean", describe: "The bounded one-line form /story loads: names only, core-first over the cap" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleTermList(
                {
                  core: argv.core as boolean | undefined,
                  thin: argv.thin as boolean | undefined,
                  digest: argv.digest as boolean | undefined,
                },
                ctx,
              ),
            );
          },
        )
        .command(
          "get <id>",
          "Show one term: its definition, the distinction that matters, and what it links to",
          (y2) => addFormatOption(y2.positional("id", { type: "string", demandOption: true, describe: "Term ID (term-<slug>)" })),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleTermGet(argv.id as string, ctx));
          },
        )
        .command(
          "match",
          "Which glossary terms appear in a piece of text. Whole-word and case-insensitive; a match SUGGESTS a term and changes nothing.",
          (y2) =>
            addFormatOption(
              y2.option("text", { type: "string", demandOption: true, describe: "The text to search, normally an item's title and description" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleTermMatch(argv.text as string, ctx));
          },
        )
        .command(
          "check",
          "Check every term's capability and ruling links, and flag the entries that are thin",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleTermCheck(ctx));
          },
        )
        .command(
          "add",
          "Add a term. One word belongs to one entry, so a name another entry already owns is refused.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .option("id", { type: "string", demandOption: true, describe: "Term ID (term-<slug>)" })
                  .option("term", { type: "string", demandOption: true, describe: "The canonical term" })
                  .option("definition", { type: "string", demandOption: true, describe: "One sentence: what it means here" })
                  .option("distinction", { type: "string", describe: "One sentence: what it is NOT, or what it differs from" })
                  .option("core", { type: "boolean", describe: "Eligible for the digest when the glossary is over its cap" })
                  .option("added-by", { type: "string", describe: "Who filed it" }),
                {
                  alias: { ...LITERAL_DROP_BLANK, describe: "Another name for this term (repeatable; a comma is legal in a phrase, so repeat the flag)" },
                  capability: { ...SPLIT_LIST, describe: "Capability ID this term belongs to (repeatable)" },
                  ruling: { ...SPLIT_LIST, describe: "Ruling ID that settled this term (repeatable)" },
                },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) => handleTermAdd(termWriteInput(argv), format, root), true);
          },
        )
        .command(
          "update <id>",
          "Edit a term. Supplied list flags replace the stored lists.",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              arrayOptions(
                y2
                  .positional("id", { type: "string", demandOption: true, describe: "Term ID" })
                  .option("term", { type: "string", describe: "The canonical term" })
                  .option("definition", { type: "string", describe: "One sentence: what it means here" })
                  .option("distinction", { type: "string", describe: "One sentence: what it is NOT" })
                  .option("core", { type: "boolean", describe: "Mark or unmark as core" })
                  .option("added-by", { type: "string", describe: "Who filed it" })
                  .option("clear-pending", { type: "boolean", describe: "Clear the pending note set by term defer" }),
                {
                  alias: { ...LITERAL_DROP_BLANK, describe: "Aliases, REPLACING the current list (repeatable; a comma is legal in a phrase, so repeat the flag)" },
                  capability: { ...SPLIT_LIST, describe: "Capability IDs, replacing the current list (repeatable)" },
                  ruling: { ...SPLIT_LIST, describe: "Ruling IDs, replacing the current list (repeatable)" },
                },
              ),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) =>
              handleTermUpdate({ ...termWriteInput(argv), id: argv.id as string, clearPending: argv["clear-pending"] as boolean | undefined }, format, root), true,
            );
          },
        )
        .command(
          "defer <id>",
          "Record work owed on a term without doing it: sets a pending note, touches nothing else",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Term ID" })
                .option("note", { type: "string", demandOption: true, describe: "One sentence naming the owed work" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) => handleTermDefer({ id: argv.id as string, note: argv.note as string }, format, root), true);
          },
        )
        .command(
          "restore <id>",
          "Restore one term to its projection at --from, refused unless it still matches its projection at --expect",
          (y: Argv) => addCommitOption(((y2) => addRestoreOptions(y2.positional("id", { type: "string", demandOption: true, describe: "Term ID" })))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) =>
              handleTermRestore({ id: argv.id as string, from: argv.from as string, expect: argv.expect as string }, format, root), true,
            );
          },
        )
        .command(
          "remove <id>",
          "Remove a term. Refused while any capability references it: the other file is never edited to make this possible.",
          (y: Argv) => addCommitOption(((y2) => addFormatOption(y2.positional("id", { type: "string", demandOption: true, describe: "Term ID" })))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runCatalogWrite(argv, format, (root) => handleTermRemove(argv.id as string, format, root), true);
          },
        ),
  );
}

/** Flag-to-input mapping shared by `term add` and `term update`. */
function termWriteInput(argv: Record<string, unknown>): TermWriteInput {
  return {
    id: argv.id as string,
    term: argv.term as string | undefined,
    aliases: argv.alias as string[] | undefined,
    definition: argv.definition as string | undefined,
    distinction: argv.distinction as string | undefined,
    capabilities: argv.capability as string[] | undefined,
    rulings: argv.ruling as string[] | undefined,
    core: argv.core as boolean | undefined,
    addedBy: argv["added-by"] as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// ledger (T-526, D4)
// ---------------------------------------------------------------------------

export function registerLedgerCommand(yargs: Argv): Argv {
  return yargs.command("ledger", "Single-record ledger operations", (y) =>
    y
      .command(
        "restore <path>",
        "Restore one ruling, note or issue file to its bytes at --from, refused unless it still matches its projection at --expect",
        (y: Argv) => addCommitOption(((y2) =>
          addRestoreOptions(
            y2.positional("path", { type: "string", demandOption: true, describe: "Repo-relative path: .story/<rulings|notes|issues>/<id>.json" }),
          ))(y)),
        async (argv) => {
          const format = parseOutputFormat(argv.format);
          await runCatalogWrite(argv, format, (root) =>
            handleLedgerRestore({ path: argv.path as string, from: argv.from as string, expect: argv.expect as string }, format, root),
          );
        },
      )
      .demandCommand(1, "Specify a ledger subcommand: restore"),
  );
}

// ---------------------------------------------------------------------------
// brief (T-526)
// ---------------------------------------------------------------------------

export function registerBriefCommand(yargs: Argv): Argv {
  return yargs.command(
    "brief <id>",
    "The context brief for a ticket or issue: its binding rulings, suggested rulings, capabilities, terms, and what discovery could not see. Read-only; suggestions bind nothing.",
    (y: Argv) => addCommitOption(((y) =>
      addFormatOption(
        y
          .positional("id", { type: "string", demandOption: true, describe: "Ticket or issue ID (with --rebase, the item whose manifest is rebased)" })
          .option("budget", { type: "number", describe: "Byte budget for the rendered brief (default 16000)" })
          .option("rebase", { type: "string", describe: "Session ID: adopt that session's latest provisional context manifest for <id> after recovery" })
          .option("reason", { type: "string", describe: "With --rebase: why the provisional context is being adopted (required)" })
          .option("by", { type: "string", describe: "With --rebase: who is adopting it", default: "cli" }),
      ))(y)),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      if (argv.rebase !== undefined) {
        await runCatalogWrite(argv, format, (root) =>
          handleBriefRebase(
            { sessionId: argv.rebase as string, item: argv.id as string, reason: (argv.reason as string | undefined) ?? "", by: argv.by as string },
            format,
            root,
          ),
        );
        return;
      }
      await runReadCommand(format, (ctx) => handleBrief(argv.id as string, { budget: argv.budget }, ctx));
    },
  );
}

// ---------------------------------------------------------------------------
// checkpoint (T-537)
// ---------------------------------------------------------------------------

async function runCheckpointCommand(argv: BoardWriteArgv, format: RulingOutputFormat, fn: (root: string) => Promise<RulingCommandResult>): Promise<void> {
  const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
  if (!root) {
    writeOutput(formatError("not_found", "No .story/ project found.", format), format);
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  try {
    const result = await runBoardWrite(argv, format, () => fn(root));
    writeOutput(result.output, format);
    process.exitCode = result.exitCode ?? ExitCode.OK;
  } catch (err: unknown) {
    const { ProjectLoaderError } = await import("../core/errors.js");
    if (err instanceof CliValidationError || err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
    } else {
      writeOutput(formatError("io_error", err instanceof Error ? err.message : String(err), format), format);
    }
    process.exitCode = ExitCode.USER_ERROR;
  }
}

/** The state a lifecycle change names, as `checkpoint list` prints it. */
function expectedOptions<T>(y: Argv<T>) {
  return y
    .option("generation", { type: "number", demandOption: true, describe: "The checkpoint generation you last saw" })
    .option("revision", { type: "number", demandOption: true, describe: "The checkpoint revision you last saw" })
    .option("digest", { type: "string", demandOption: true, describe: "The checkpoint digest you last saw" })
    .option("actor", { type: "string", describe: "Who is acting (defaults to the configured actor)" });
}

function contentOptions<T>(y: Argv<T>, required: boolean) {
  return y
    .option("kind", { type: "string", choices: ["decision", "acceptance"], demandOption: required, describe: "decision (a question) or acceptance (criteria)" })
    .option("question", { type: "string", describe: "The question a decision asks the owner" })
    .option("criteria", { type: "string", describe: "What an acceptance checks" });
}

/**
 * The --evidence-ref spec each content-taking checkpoint command registers in
 * its own builder: the ISS-886 coverage gate names a registration only inside
 * a .command() builder (ISS-1343).
 */
const EVIDENCE_REF = { ...SPLIT_LIST, describe: "References the owner reviews (paths, URLs, ids)" } as const;

const contentOf = (argv: Record<string, unknown>) => ({
  kind: argv.kind as string | undefined,
  question: argv.question as string | undefined,
  criteria: argv.criteria as string | undefined,
  evidenceRefs: (argv["evidence-ref"] as string[] | undefined) ?? [],
});

const expectedOf = (argv: Record<string, unknown>) => ({
  generation: argv.generation as number,
  revision: argv.revision as number,
  digest: argv.digest as string,
  actor: argv.actor as string | undefined,
});

export function registerCheckpointCommand(yargs: Argv): Argv {
  return yargs.command(
    "checkpoint",
    "Owner checkpoints: decisions and acceptances only the owner answers",
    (y) =>
      y
        .command("enable", "Turn owner checkpoints on for this project (stamps schemaVersion 4)", (y: Argv) => addCommitOption(((y2) => addFormatOption(y2))(y)), async (argv) => {
          const format = parseOutputFormat(argv.format);
          const { handleCheckpointEnable } = await import("./commands/checkpoint.js");
          await runCheckpointCommand(argv, format, (root) => handleCheckpointEnable(format, root));
        })
        .command(
          "create",
          "Create a ticket that is an owner checkpoint",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(arrayOptions(
              contentOptions(y2, true)
                .option("title", { type: "string", demandOption: true, describe: "Ticket title" })
                .option("owner", { type: "string", demandOption: true, describe: "Who answers the checkpoint" })
                .option("phase", { type: "string", describe: "Phase ID" })
                .option("description", { type: "string", describe: "Ticket description" })
                .option("parent-ticket", { type: "string", describe: "Parent ticket ID" })
                .option("actor", { type: "string", describe: "Who is acting (defaults to the configured actor)" }),
              { "evidence-ref": EVIDENCE_REF, "blocked-by": { ...SPLIT_LIST, describe: "IDs of blocking tickets" } },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointCreate } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, (root) => handleCheckpointCreate({
              ...contentOf(argv),
              title: argv.title as string,
              owner: argv.owner as string,
              phase: (argv.phase as string | undefined) ?? null,
              description: argv.description as string | undefined,
              parentTicket: argv["parent-ticket"] as string | undefined,
              blockedBy: argv["blocked-by"] as string[] | undefined,
              actor: argv.actor as string | undefined,
            }, format, root));
          },
        )
        .command(
          "attach <id>",
          "Make an open, unclaimed ticket an owner checkpoint",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(arrayOptions(
              contentOptions(y2, true)
                .positional("id", { type: "string", demandOption: true, describe: "Ticket ID" })
                .option("owner", { type: "string", demandOption: true, describe: "Who answers the checkpoint" })
                .option("actor", { type: "string", describe: "Who is acting (defaults to the configured actor)" }),
              { "evidence-ref": EVIDENCE_REF },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointAttach } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, (root) =>
              handleCheckpointAttach(argv.id as string, { ...contentOf(argv), owner: argv.owner as string, actor: argv.actor as string | undefined }, format, root));
          },
        )
        .command(
          "resolve <id>",
          "Answer a checkpoint at the state you reviewed",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(arrayOptions(
              expectedOptions(y2)
                .positional("id", { type: "string", demandOption: true, describe: "Checkpoint ticket ID" })
                .option("response", { type: "string", demandOption: true, describe: "The owner's answer" })
                .option("artifact-ref", { type: "string", describe: "The reviewed artifact (required for an acceptance)" })
                .option("ruling", { type: "string", choices: ["owner-direct", "owner-via-manager-with-owner-veto", "manager-delegated"], describe: "Also record the response as an accepted ruling with this attribution, in one transaction" })
                .option("client-task-id", { type: "string", describe: "Caller identity for the ruling, if not inferable from the environment" }),
              { "ruling-scope-tag": { ...SPLIT_LIST, describe: "Scope tags for that ruling" } },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointResolve } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, (root) => handleCheckpointResolve(argv.id as string, {
              ...expectedOf(argv),
              response: argv.response as string,
              artifactRef: argv["artifact-ref"] as string | undefined,
              rulingAttribution: argv.ruling as string | undefined,
              rulingScopeTags: argv["ruling-scope-tag"] as string[] | undefined,
              clientTaskId: argv["client-task-id"] as string | undefined,
            }, format, root));
          },
        )
        .command(
          "change <id>",
          "Change what a checkpoint asks; an earlier answer no longer counts",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(arrayOptions(
              contentOptions(expectedOptions(y2), true).positional("id", { type: "string", demandOption: true, describe: "Checkpoint ticket ID" }),
              { "evidence-ref": EVIDENCE_REF },
            )))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointChange } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, (root) => handleCheckpointChange(argv.id as string, { ...expectedOf(argv), ...contentOf(argv) }, format, root));
          },
        )
        .command(
          "reopen <id>",
          "Withdraw a checkpoint's answer; it is kept in history",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              expectedOptions(y2)
                .positional("id", { type: "string", demandOption: true, describe: "Checkpoint ticket ID" })
                .option("reason", { type: "string", describe: "Why it is reopened" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointReopen } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, (root) =>
              handleCheckpointReopen(argv.id as string, { ...expectedOf(argv), reason: argv.reason as string | undefined }, format, root));
          },
        )
        .command(
          "retire <id>",
          "Retire a checkpoint that is no longer needed; its dependents are released",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              expectedOptions(y2)
                .positional("id", { type: "string", demandOption: true, describe: "Checkpoint ticket ID" })
                .option("reason", { type: "string", demandOption: true, describe: "Why it is retired" }),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointRetire } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, (root) =>
              handleCheckpointRetire(argv.id as string, { ...expectedOf(argv), reason: argv.reason as string | undefined }, format, root));
          },
        )
        .command(
          "resolve-conflict <id>",
          "Settle a merge conflict on a checkpoint (the selected approval is displaced; the other side is kept in history)",
          (y: Argv) => addCommitOption(((y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Checkpoint ticket ID" })
                .option("use", { type: "string", choices: ["ours", "theirs"], describe: "Take one side" })
                .option("field", { type: "string", describe: "One conflicted field (or _entity)" })
                .option("value", { type: "string", describe: "A JSON value to use instead of either side" })
                .option("actor", { type: "string", describe: "Who is acting (defaults to the configured actor)" })
                .conflicts("use", "value"),
            ))(y)),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointResolveConflict } = await import("./commands/checkpoint.js");
            await runCheckpointCommand(argv, format, async (root) => {
              let value: unknown;
              if (argv.value !== undefined) {
                try {
                  value = JSON.parse(argv.value as string);
                } catch {
                  throw new CliValidationError("invalid_input", "--value must be JSON");
                }
              }
              return handleCheckpointResolveConflict(argv.id as string, {
                use: argv.use as "ours" | "theirs" | undefined,
                field: argv.field as string | undefined,
                ...(argv.value !== undefined ? { value } : {}),
                actor: argv.actor as string | undefined,
              }, format, root);
            });
          },
        )
        .command(
          "list",
          "List owner checkpoints with the state each change must name",
          (y2) => addFormatOption(y2.option("state", { type: "string", choices: ["pending", "approved", "retired", "unrecognized"], describe: "Only this state" })),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const { handleCheckpointList } = await import("./commands/checkpoint.js");
            await runReadCommand(format, async () => {
              const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
              if (!root) throw new CliValidationError("not_found", "No .story/ project found.");
              return handleCheckpointList(format, root, { state: argv.state as string | undefined });
            });
          },
        )
        .demandCommand(1, "Specify a checkpoint subcommand: enable, create, attach, resolve, change, reopen, retire, resolve-conflict, list")
        .strict(),
    () => {},
  );
}
