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
import { runReadCommand, runReadCommandWithRoot, runDeleteCommand, writeOutput } from "./run.js";
import {
  addFormatOption,
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
import { arrayOptions, arrayPositional } from "./array-options.js";

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
    describe: "Node name (orchestrator only). Operates on that node's .story/ instead of the orchestrator's.",
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
    (y) => addFormatOption(y),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      await runReadCommand(format, handleStatus);
    },
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
        writeOutput(formatError("not_found", "No .story/ project found.", format));
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }

      const integrityOnly = argv["integrity-only"] as boolean;
      const integrity = await scanLedgerIntegrity(root, {
        includeAuxiliary: integrityOnly,
      });
      if (integrityOnly || !integrity.valid) {
        writeOutput(formatLedgerIntegrity(integrity, format));
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
            writeOutput(result.error);
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          if (result.fixes.length === 0) {
            writeOutput("No stale references found. Project is clean.");
            return;
          }
          await applyRepairPatches(root, result.patches);
          const lines = [`Fixed ${result.fixes.length} stale reference(s):`, ""];
          for (const fix of result.fixes) {
            lines.push(`- ${fix.entity}.${fix.field}: ${fix.description}`);
          }
          writeOutput(lines.join("\n"));
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
      writeOutput(result.output);
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
            if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok")); process.exitCode = ExitCode.USER_ERROR; return; }
            const { handleConflictsList } = await import("./commands/conflicts.js");
            const result = await handleConflictsList(root, (argv.format as "md" | "json") ?? "md");
            writeOutput(result.output);
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
            if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok")); process.exitCode = ExitCode.USER_ERROR; return; }
            const { handleConflictsShow } = await import("./commands/conflicts.js");
            const result = await handleConflictsShow(argv.id as string, root, (argv.format as "md" | "json") ?? "md");
            writeOutput(result.output);
            if (result.exitCode) process.exitCode = result.exitCode;
          },
        )
        .demandCommand(1, ""),
    () => {},
  );
}

export function registerResolveCommand(yargs: Argv): Argv {
  return yargs.command(
    "resolve <id>",
    "Resolve merge conflicts on a .story/ item",
    (y) =>
      addFormatOption(y
        .positional("id", { type: "string", demandOption: true, describe: "Entity ID" })
        .option("field", { type: "string", describe: "Resolve a specific field" })
        .option("use", { type: "string", choices: ["ours", "theirs"], describe: "Pick a side" })
        .option("value", { type: "string", describe: "Custom value (JSON)" }), 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
    async (argv) => {
      const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
      if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok")); process.exitCode = ExitCode.USER_ERROR; return; }
      try {
        const { handleResolve } = await import("./commands/conflicts.js");
        let parsedValue: unknown;
        if (argv.value !== undefined) {
          try { parsedValue = JSON.parse(argv.value as string); } catch { parsedValue = argv.value; }
        }
        const result = await handleResolve(argv.id as string, root, {
          field: argv.field as string | undefined,
          use: argv.use as "ours" | "theirs" | undefined,
          value: parsedValue,
          format: (argv.format as "md" | "json") ?? "md",
        });
        writeOutput(result.output);
        if (result.exitCode) process.exitCode = result.exitCode;
      } catch (err: unknown) {
        // ISS-910: same rule the gc and team-reserve adapters already follow
        // (ISS-805 R3) -- a post-validation handler failure still honors
        // --format json, emitting one parseable { ok:false, error } object
        // rather than prose an automated caller cannot read.
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(
          argv.format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message,
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
        writeOutput(noProjectFoundOutput(argv.format, "ok"));
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
        writeOutput(result.output);
        if (result.exitCode) process.exitCode = result.exitCode;
      } catch (err: unknown) {
        // ISS-805 R3: a post-validation handler failure must still honor
        // --format json, emitting one parseable { ok:false, error } object.
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(
          gcFormat === "json"
            ? JSON.stringify({ ok: false, error: message }, null, 2)
            : message,
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
    "merge-driver <ancestor> <ours> <theirs> <pathname>",
    "Git merge driver for .story/ JSON files",
    (y) =>
      y
        .positional("ancestor", { type: "string", demandOption: true, describe: "Base (common ancestor) file path" })
        .positional("ours", { type: "string", demandOption: true, describe: "Our (HEAD) file path" })
        .positional("theirs", { type: "string", demandOption: true, describe: "Their (incoming) file path" })
        .positional("pathname", { type: "string", demandOption: true, describe: "Logical file path (%P)" }),
    async (argv) => {
      const { handleMergeDriver } = await import("./commands/merge-driver.js");
      const exitCode = await handleMergeDriver(
        argv.ancestor as string,
        argv.ours as string,
        argv.theirs as string,
        argv.pathname as string,
      );
      process.exitCode = exitCode;
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
          writeOutput(result.output);
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
            writeOutput(res.output);
            if (res.exitCode) process.exitCode = res.exitCode;
            return;
          }
          const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
          if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok")); process.exitCode = ExitCode.USER_ERROR; return; }
          try {
            const result = await handleReserve(root, argv.type as "tickets" | "issues" | "notes" | "lessons", argv.count as number, reserveFormat);
            writeOutput(result.output);
            if (result.exitCode) process.exitCode = result.exitCode;
          } catch (err: unknown) {
            // ISS-805 R3: a post-validation handler failure must still honor
            // --format json, emitting one parseable { ok:false, error } object.
            const message = err instanceof Error ? err.message : String(err);
            writeOutput(
              reserveFormat === "json"
                ? JSON.stringify({ ok: false, error: message }, null, 2)
                : message,
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
          if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok")); process.exitCode = ExitCode.USER_ERROR; return; }
          const { handleTeamInit } = await import("./commands/team-init.js");
          const result = await handleTeamInit(root, {
            claimStalenessHours: argv["claim-staleness-hours"] as number | undefined,
            idAllocator: argv["id-allocator"] as "local" | "git-refs" | undefined,
            format: (argv.format as "md" | "json") ?? "md",
          });
          writeOutput(result.output);
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        },
      )
      .command(
        "setup",
        "Install git merge driver and .gitattributes for team mode",
        (y2) => addFormatOption(y2, "its own top-level result object with no envelope"),
        async (argv) => {
          const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
          if (!root) { writeOutput(noProjectFoundOutput(argv.format, "ok")); process.exitCode = ExitCode.USER_ERROR; return; }
          const { handleTeamSetup } = await import("./commands/team-setup.js");
          const result = await handleTeamSetup(root, { format: (argv.format as "md" | "json") ?? "md" });
          writeOutput(result.output);
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
                if (!root) { writeOutput(noProjectFoundOutput(argv.format, "envelope")); process.exitCode = ExitCode.USER_ERROR; return; }
                const { handleTeamConfigShow } = await import("./commands/team-config.js");
                const result = handleTeamConfigShow(root, parseOutputFormat(argv.format));
                writeOutput(result.output);
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
                if (!root) { writeOutput(noProjectFoundOutput(argv.format, "envelope")); process.exitCode = ExitCode.USER_ERROR; return; }
                const { handleTeamConfigSet } = await import("./commands/team-config.js");
                const result = await handleTeamConfigSet(root, argv.key as string, argv.value as string, parseOutputFormat(argv.format));
                writeOutput(result.output);
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
        writeOutput(formatError("not_found", "No .story/ project found.", format));
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      const result = await handleMigrate(root, format, { dryRun });
      writeOutput(result.output);
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
              y2.option("count", {
                type: "number",
                default: 1,
                describe: "Number of recent handovers to return (default: 1)",
              }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const count = Math.max(1, Math.floor(argv.count as number));
            await runReadCommand(format, (ctx) =>
              handleHandoverLatest(ctx, count),
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
          (y2) =>
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
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }

            let content: string;
            if (argv.stdin) {
              if (process.stdin.isTTY) {
                writeOutput(
                  formatError("invalid_input", "Cannot read from stdin: no pipe detected. Use --content instead.", format),
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
              const result = await handleHandoverCreate(
                content,
                argv.slug as string,
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .demandCommand(1, "Specify a handover subcommand: list, latest, get, create")
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
          (y2) =>
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
            ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handleBlockerAdd(
                {
                  name: argv.name as string,
                  note: argv.note as string | undefined,
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "clear",
          "Clear (resolve) a blocker",
          (y2) =>
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
            ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handleBlockerClear(
                argv.name as string,
                argv.note as string | undefined,
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
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
              if (!orchRoot) { writeOutput(formatError("not_found", "No .story/ project found.", format)); process.exitCode = ExitCode.USER_ERROR; return; }
              const eff = resolveRootWithNode(orchRoot, nodeName, false, format);
              if (!eff.ok) { writeOutput(eff.output); process.exitCode = ExitCode.USER_ERROR; return; }
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
          (y2) =>
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
                  describe: "Phase ID",
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
              { "blocked-by": { ...SPLIT_LIST, describe: "IDs of blocking tickets" } },
            ))),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, argv.node as string | undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let description = (argv.description as string | undefined) ?? "";
              if (argv.stdin) {
                description = await readStdinContent();
              }
              const result = await handleTicketCreate(
                {
                  title: argv.title as string,
                  type: argv.type as string,
                  phase: argv.phase === "" ? null : (argv.phase as string | undefined) ?? null,
                  description,
                  blockedBy: (
                    argv["blocked-by"] as string[] | undefined ?? []
                  ),
                  parentTicket:
                    argv["parent-ticket"] === "" ? null : (argv["parent-ticket"] as string | undefined) ?? null,
                },
                format,
                eff.root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update a ticket",
          (y2) =>
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
                .conflicts("description", "stdin"),
              {
                "blocked-by": { ...SPLIT_LIST, describe: "IDs of blocking tickets" },
                "cross-node-blocked-by": {
                  ...LEGACY_SPLIT_LIST,
                  describe: "Cross-node blocking refs (e.g. engine:T-001). Bare flag clears.",
                },
              },
            )),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, argv.node as string | undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output);
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
              const result = await handleTicketUpdate(
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
                },
                format,
                eff.root,
                argv.force as boolean,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "meta <operation> <id> [path] [value]",
          "Get, set, or unset custom ticket metadata",
          (y2) =>
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
            ),
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
                ? await handleTicketMetaSet(
                  id,
                  path,
                  parseMetadataValue(rawValue!),
                  format,
                  root,
                )
                : await handleTicketMetaUnset(id, path, format, root);
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "move <id>",
          "Move a ticket relative to another (fractional rank)",
          (y2) =>
            addFormatOption(
              y2
                .positional("id", { type: "string", demandOption: true, describe: "Ticket ID to move" })
                .option("after", { type: "string", describe: "Place after this ticket" })
                .option("before", { type: "string", describe: "Place before this ticket" }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const root = (await import("../core/project-root-discovery.js")).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format));
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const { handleTicketMove } = await import("./commands/move.js");
              const result = await handleTicketMove(id, root, {
                after: argv.after as string | undefined,
                before: argv.before as string | undefined,
                format: format as "md" | "json",
              });
              writeOutput(result.output);
              if (result.exitCode) process.exitCode = result.exitCode;
            } catch (err: unknown) {
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a ticket",
          (y2) =>
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
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const force = argv.force as boolean;
            const hard = argv.hard as boolean;
            const { resolveAndNormalizeTicketRef } = await import("../core/ref-normalization.js");
            await runDeleteCommand(format, force, async (ctx) => {
              const resolvedId = resolveAndNormalizeTicketRef(ctx.state, id);
              const ticket = ctx.state.ticketByID(resolvedId);
              return handleTicketDelete(resolvedId, force, format, ctx.root, hard, ticket?.displayId ?? resolvedId);
            });
          },
        )
        .command(
          "unclaim <id>",
          "Remove claim from a ticket",
          (y2) => addFormatOption(
            y2.positional("id", { type: "string", demandOption: true, describe: "Ticket ID" }),
          ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handleTicketUnclaim(id, format, eff.root);
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "start <id>",
          "Claim a ticket and set status to inprogress",
          (y2) => addFormatOption(
            y2.positional("id", { type: "string", demandOption: true, describe: "Ticket ID" })
              .option("force", { type: "boolean", default: false, describe: "Take over a teammate's claim without a warning (claims are advisory; start never hard-blocks)" }),
          ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handleTicketStart(id, format, eff.root, force);
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
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
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleIssueList(
                {
                  status: argv.status as string | undefined,
                  severity: argv.severity as string | undefined,
                  component: argv.component as string | undefined,
                  phase: argv.phase as string | undefined,
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
          (y2) =>
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
              },
            )),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let impact = (argv.impact as string | undefined) ?? "";
              if (argv.stdin) {
                impact = await readStdinContent();
              }
              const result = await handleIssueCreate(
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
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update an issue",
          (y2) =>
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
                .conflicts("impact", "stdin"),
              {
                components: { ...SPLIT_LIST, describe: "Affected components" },
                "related-tickets": { ...SPLIT_LIST, describe: "Related ticket IDs" },
                location: { ...LITERAL_DROP_BLANK, describe: "File locations" },
                "source-ref": {
                  ...LITERAL_KEEP_BLANK,
                  describe: "Replacement source ref (JSON object)",
                },
              },
            )),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              let impact = argv.impact as string | undefined;
              if (argv.stdin) {
                impact = await readStdinContent();
              }
              const result = await handleIssueUpdate(
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
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "meta <operation> <id> [path] [value]",
          "Get, set, or unset custom issue metadata",
          (y2) =>
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
            ),
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
                ? await handleIssueMetaSet(
                  id,
                  path,
                  parseMetadataValue(rawValue!),
                  format,
                  root,
                )
                : await handleIssueMetaUnset(id, path, format, root);
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete an issue",
          (y2) =>
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
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseIssueId(argv.id as string);
            const hard = argv.hard as boolean;
            const { resolveAndNormalizeIssueRef } = await import("../core/ref-normalization.js");
            await runDeleteCommand(format, false, async (ctx) => {
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
              if (!orchRoot) { writeOutput(formatError("not_found", "No .story/ project found.", format)); process.exitCode = ExitCode.USER_ERROR; return; }
              const eff = resolveRootWithNode(orchRoot, nodeName, false, format);
              if (!eff.ok) { writeOutput(eff.output); process.exitCode = ExitCode.USER_ERROR; return; }
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
          (y2) =>
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
            ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            const eff = resolveRootWithNode(orchRoot, argv.node as string | undefined, true, format);
            if (!eff.ok) {
              writeOutput(eff.output);
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handlePhaseCreate(
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
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "rename <id>",
          "Rename/update phase metadata",
          (y2) =>
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
            ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handlePhaseRename(
                id,
                {
                  name: argv.name as string | undefined,
                  label: argv.label as string | undefined,
                  description: argv.description as string | undefined,
                  summary: argv.summary as string | undefined,
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "move <id>",
          "Move a phase to a new position",
          (y2) =>
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
            ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handlePhaseMove(
                id,
                {
                  after: argv.after as string | undefined,
                  atStart: argv.atStart as boolean,
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a phase",
          (y2) =>
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
            ),
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
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handlePhaseDelete(
                id,
                argv.reassign as string | undefined,
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import(
                "../core/errors.js"
              );
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
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
    (y) =>
      addFormatOption(
        y.option("quiet", {
          type: "boolean",
          default: false,
          describe: "Suppress output (for hook usage)",
        }),
      ),
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
        );
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      try {
        const result = await handleSnapshot(root, format, { quiet });
        if (!quiet && result.output) {
          writeOutput(result.output);
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
          writeOutput(formatError(err.code, err.message, format));
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const { ProjectLoaderError } = await import("../core/errors.js");
        if (err instanceof ProjectLoaderError) {
          writeOutput(formatError(err.code, err.message, format));
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, format));
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
          (y2) =>
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
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
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
              const result = await handleNoteCreate(
                {
                  content,
                  title: argv.title as string | undefined ?? null,
                  tags: argv.tags as string[] | undefined,
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update a note",
          (y2) =>
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
                .conflicts("content", "stdin")
                .conflicts("tags", "clear-tags"),
              {
                tags: {
                  ...SPLIT_LIST,
                  describe: "New tags (replaces existing)",
                  requireValue: "Use --clear-tags to clear tags.",
                },
              },
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseNoteId(argv.id as string);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
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
              const result = await handleNoteUpdate(
                id,
                {
                  content,
                  title: argv.title === ""
                    ? null
                    : (argv.title as string | undefined),
                  tags: argv.tags as string[] | undefined,
                  clearTags: argv["clear-tags"] as boolean,
                  status: argv.status as string | undefined,
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a note",
          (y2) =>
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
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseNoteId(argv.id as string);
            const hard = argv.hard as boolean;
            const { resolveAndNormalizeNoteRef } = await import("../core/ref-normalization.js");
            await runDeleteCommand(format, false, async (ctx) => {
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

export function registerReferenceCommand(yargs: Argv): Argv {
  return yargs.command(
    "reference",
    "Print CLI command and MCP tool reference",
    (y) => addFormatOption(y),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const output = handleReference(format);
      writeOutput(output);
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
      }),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      const raw = Number(argv.count) || 5;
      const count = Math.max(1, Math.min(10, Math.floor(raw)));
      await runReadCommand(format, (ctx) => handleRecommend(ctx, count));
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
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) => handleLessonDigest(ctx));
          },
        )
        .command(
          "create",
          "Create a lesson",
          (y2) =>
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
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
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
              const result = await handleLessonCreate(
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
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <id>",
          "Update a lesson",
          (y2) =>
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
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseLessonId(argv.id as string);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
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
              const result = await handleLessonUpdate(
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
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "reinforce <id>",
          "Reinforce a lesson -- increment reinforcement count and update lastValidated",
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
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(
                formatError("not_found", "No .story/ project found.", format),
              );
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handleLessonReinforce(id, format, root);
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "delete <id>",
          "Delete a lesson",
          (y2) =>
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
            ),
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
              const result = await handleLessonDelete(resolvedId, format, root, hard, lesson?.displayId ?? resolvedId);
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { RefResolutionError } = await import("../core/ref-normalization.js");
              if (err instanceof RefResolutionError) {
                // ISS-805: an ambiguous ref is caller input, not a project
                // conflict; classify it invalid_input, keep missing as not_found.
                const code = err.reason === "missing" ? "not_found" : "invalid_input";
                writeOutput(formatError(code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
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
          (y2) =>
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
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format));
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const links = (argv.link as string[] | undefined)?.map((l) => {
                const colonIdx = l.indexOf(":");
                if (colonIdx === -1) return { to: l };
                return { to: l.slice(0, colonIdx), via: l.slice(colonIdx + 1) };
              });
              const result = await handleNodeAdd(
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
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "remove <name>",
          "Remove a node from orchestrator config",
          (y2) =>
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
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format));
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const result = await handleNodeRemove(
                argv.name as string,
                {
                  force: argv.force as boolean,
                  prune: argv.prune as boolean,
                },
                format,
                root,
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
              process.exitCode = ExitCode.USER_ERROR;
            }
          },
        )
        .command(
          "update <name>",
          "Update an existing node's metadata",
          (y2) =>
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
            )),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const root = (
              await import("../core/project-root-discovery.js")
            ).discoverProjectRoot();
            if (!root) {
              writeOutput(formatError("not_found", "No .story/ project found.", format));
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            try {
              const links = (argv.link as string[] | undefined)?.map((l) => {
                const colonIdx = l.indexOf(":");
                if (colonIdx === -1) return { to: l };
                return { to: l.slice(0, colonIdx), via: l.slice(colonIdx + 1) };
              });
              const result = await handleNodeUpdate(
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
              );
              writeOutput(result.output);
              process.exitCode = result.exitCode ?? ExitCode.OK;
            } catch (err: unknown) {
              if (err instanceof CliValidationError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const { ProjectLoaderError } = await import("../core/errors.js");
              if (err instanceof ProjectLoaderError) {
                writeOutput(formatError(err.code, err.message, format));
                process.exitCode = ExitCode.USER_ERROR;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
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
        );
        process.exitCode = ExitCode.USER_ERROR;
        return;
      }
      try {
        const result = await handleSelftest(root, format);
        writeOutput(result.output);
        process.exitCode = result.exitCode ?? ExitCode.OK;
      } catch (err: unknown) {
        if (err instanceof CliValidationError) {
          writeOutput(formatError(err.code, err.message, format));
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const { ProjectLoaderError } = await import("../core/errors.js");
        if (err instanceof ProjectLoaderError) {
          writeOutput(formatError(err.code, err.message, format));
          process.exitCode = ExitCode.USER_ERROR;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, format));
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
        writeOutput(JSON.stringify(result, null, 2));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(formatError("io_error", message, "json"));
        process.exitCode = ExitCode.USER_ERROR;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

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
        }),
    async (argv) => {
      const { handleSetup } = await import("./commands/setup-skill.js");
      await handleSetup({
        client: argv.client as SetupClient,
        skipHooks: argv["skip-hooks"] === true,
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
// limit-status (T-424: pending limit auto-resumes)
// ---------------------------------------------------------------------------

export function registerLimitStatusCommand(yargs: Argv): Argv {
  return yargs.command(
    "limit-status",
    "Show pending usage-limit auto-resumes (global, all projects)",
    (y) =>
      addFormatOption(y
        .option("cancel", {
          type: "string",
          describe: "Cancel the pending auto-resume for a record key or client session id",
        })
        .option("requeue", {
          type: "string",
          describe: "Return a manual/failed record to the wake queue",
        }), 'an {"ok", "data"} object (or {"ok", "error"} on failure)'),
    async (argv) => {
      const { handleLimitStatus } = await import("./commands/limit-status.js");
      try {
        const result = await handleLimitStatus({
          cancel: argv.cancel as string | undefined,
          requeue: argv.requeue as string | undefined,
          format: argv.format as "json" | "md",
        });
        // ISS-910: all output through writeOutput, never process.stdout. This
        // command does NOT register --raw (its JSON shape is deviant, so the
        // flag is rejected during argument validation); the seam still owns
        // EPIPE handling and keeps one output path for the whole CLI.
        writeOutput(result.output);
        if (result.errorCode) process.exitCode = 1;
      } catch (err: unknown) {
        // ISS-910: an automated caller parses stdout. Answering only on
        // stderr left it with empty stdout on failure, which is as
        // unparseable as prose; emit this command's documented shape.
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(
          argv.format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message,
        );
        process.exitCode = 1;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// waker-run (T-424: hidden detached limit-waker entry point)
// ---------------------------------------------------------------------------

export function registerWakerRunCommand(yargs: Argv): Argv {
  return yargs.command(
    "waker-run",
    false as unknown as string, // hidden -- spawned detached by spawnWakerIfNeeded
    (y) =>
      y
        .option("sb-waker", {
          type: "boolean",
          default: false,
          hidden: true,
          describe: "argv sentinel for PID-reuse-safe singleton identification",
        })
        .option("once", {
          type: "boolean",
          default: false,
          hidden: true,
          describe: "Run a single poll tick and exit (E2E simulation / debugging)",
        }),
    async (argv) => {
      // Require the singleton sentinel BEFORE entering the loop. A sentinel-less
      // run would acquire and heartbeat the waker.lock while isWakerAlive()
      // reports it absent (its argv lacks the marker), so every later
      // housekeeping invocation would spawn another waker that futilely contends.
      if (argv.sbWaker !== true) {
        process.stderr.write(
          "[storybloq] waker-run is an internal, self-spawned command; run it via the auto-resume flow, not directly.\n",
        );
        return;
      }
      try {
        const { runWaker } = await import("../autonomous/waker.js");
        await runWaker(undefined, argv.once === true ? { maxTicks: 1 } : {});
      } catch (err) {
        process.stderr.write(
          `[storybloq] waker exited with error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
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
        (y2) =>
          addFormatOption(y2
            .option("json", {
              type: "string",
              describe: "JSON object to merge into recipeOverrides",
            })
            .option("clear", {
              type: "boolean",
              describe: "Remove recipeOverrides entirely (reset to defaults)",
            })),
        async (argv) => {
          const { handleConfigSetOverrides } = await import("./commands/config-update.js");
          const { writeOutput } = await import("./run.js");
          const format = argv.format as "json" | "md";
          try {
            const result = await handleConfigSetOverrides(
              process.cwd(),
              format,
              { json: argv.json as string | undefined, clear: argv.clear === true },
            );
            writeOutput(result.output);
            if (result.errorCode) process.exitCode = 1;
          } catch (err: unknown) {
            const { formatError, ExitCode } = await import("../core/output-formatter.js");
            const { ProjectLoaderError } = await import("../core/errors.js");
            if (err instanceof ProjectLoaderError) {
              writeOutput(formatError(err.code, err.message, format));
            } else {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
            }
            process.exitCode = ExitCode.USER_ERROR;
          }
        },
      )
      .command(
        "set-federation",
        "Set federation settings (orchestrator only)",
        (y2) =>
          addFormatOption(y2
            .option("allow-node-writes", {
              type: "boolean",
              describe: "Allow orchestrator MCP tools to write to node .story/ directories",
            })),
        async (argv) => {
          const { handleConfigSetFederation } = await import("./commands/config-update.js");
          const { writeOutput } = await import("./run.js");
          const format = argv.format as "json" | "md";
          const root = (
            await import("../core/project-root-discovery.js")
          ).discoverProjectRoot();
          if (!root) {
            writeOutput(formatError("not_found", "No .story/ project found.", format));
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          try {
            const result = await handleConfigSetFederation(root, format, {
              allowNodeWrites: argv["allow-node-writes"] as boolean | undefined,
            });
            writeOutput(result.output);
            if (result.errorCode) process.exitCode = 1;
          } catch (err: unknown) {
            const { ProjectLoaderError } = await import("../core/errors.js");
            if (err instanceof ProjectLoaderError) {
              writeOutput(formatError(err.code, err.message, format));
            } else {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(formatError("io_error", message, format));
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
              });
            } catch (err) {
              process.stderr.write(
                `[storybloq] resume-prompt failed: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
        )
        .command(
          "limit-stop",
          "Record a usage-limit stop for auto-resume (StopFailure hook)",
          (y2) => y2,
          async () => {
            try {
              const { handleSessionLimitStop, readHookStdinContext } = await import("./commands/session-compact.js");
              const hookContext = await readHookStdinContext(process.stdin);
              await handleSessionLimitStop({
                clientTaskId: hookContext.sessionId,
                cwd: hookContext.cwd,
                transcriptPath: hookContext.transcriptPath,
                errorType: hookContext.errorType,
                permissionMode: hookContext.permissionMode,
              });
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
                describe: "Required for limit-stopped sessions (destroys the pending auto-resume)",
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
        .demandCommand(
          1,
          "Specify a session subcommand: compact-prepare, resume-prompt, limit-stop, clear-compact, stop, list, show, repair, delete, health, watch",
        )
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
            writeOutput(result.output);
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
