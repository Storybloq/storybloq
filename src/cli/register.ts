/**
 * Consolidated yargs command registration for the CLI.
 *
 * Each register*Command function wires up yargs command definitions with
 * the corresponding handler from the commands/ directory. This file imports
 * from run.ts (EPIPE listener) and is therefore CLI-only — MCP must never
 * import this module.
 */
import type { Argv } from "yargs";
import { runReadCommand, runDeleteCommand, writeOutput } from "./run.js";
import {
  addFormatOption,
  parseOutputFormat,
  parseTicketId,
  parseIssueId,
  normalizeArrayOption,
  CliValidationError,
} from "./helpers.js";
import { formatError, ExitCode } from "../core/output-formatter.js";

// Handler imports — read handlers
import { handleStatus } from "./commands/status.js";
import { handleValidate } from "./commands/validate.js";
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
  handleTicketDelete,
} from "./commands/ticket.js";
import {
  handleIssueList,
  handleIssueGet,
  handleIssueCreate,
  handleIssueUpdate,
  handleIssueDelete,
} from "./commands/issue.js";
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

// New T-084 handler imports
import { handleRecap } from "./commands/recap.js";
import { handleExport } from "./commands/export.js";
import { handleSnapshot } from "./commands/snapshot.js";

// Reference command
import { handleReference } from "./commands/reference.js";

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
    (y) => addFormatOption(y),
    async (argv) => {
      const format = parseOutputFormat(argv.format);
      await runReadCommand(format, handleValidate);
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
          "Content of most recent handover",
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handleHandoverLatest);
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
            addFormatOption(
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
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleTicketList(
                {
                  status: argv.status as string | undefined,
                  phase: argv.phase as string | undefined,
                  type: argv.type as string | undefined,
                },
                ctx,
              ),
            );
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
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handleTicketNext);
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
            addFormatOption(
              y2
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
                  default: "",
                  describe: "Ticket description",
                })
                .option("blocked-by", {
                  type: "string",
                  array: true,
                  describe: "IDs of blocking tickets",
                })
                .option("parent-ticket", {
                  type: "string",
                  describe: "Parent ticket ID (makes this a sub-ticket)",
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
              const result = await handleTicketCreate(
                {
                  title: argv.title as string,
                  type: argv.type as string,
                  phase: argv.phase === "" ? null : (argv.phase as string | undefined) ?? null,
                  description: argv.description as string,
                  blockedBy: normalizeArrayOption(
                    argv["blocked-by"] as string[] | undefined,
                  ),
                  parentTicket:
                    argv["parent-ticket"] === "" ? null : (argv["parent-ticket"] as string | undefined) ?? null,
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
          "Update a ticket",
          (y2) =>
            addFormatOption(
              y2
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
                .option("blocked-by", {
                  type: "string",
                  array: true,
                  describe: "IDs of blocking tickets",
                })
                .option("parent-ticket", {
                  type: "string",
                  describe: "Parent ticket ID",
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
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
              const result = await handleTicketUpdate(
                id,
                {
                  status: argv.status as string | undefined,
                  title: argv.title as string | undefined,
                  phase: argv.phase === "" ? null : argv.phase as string | undefined,
                  order: argv.order as number | undefined,
                  description: argv.description as string | undefined,
                  blockedBy: argv["blocked-by"]
                    ? normalizeArrayOption(argv["blocked-by"] as string[])
                    : undefined,
                  parentTicket: argv["parent-ticket"] === "" ? null : argv["parent-ticket"] as string | undefined,
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
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            const id = parseTicketId(argv.id as string);
            const force = argv.force as boolean;
            await runDeleteCommand(format, force, async (ctx) =>
              handleTicketDelete(id, force, format, ctx.root),
            );
          },
        )
        .demandCommand(
          1,
          "Specify a ticket subcommand: list, get, next, blocked, create, update, delete",
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
                }),
            ),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, (ctx) =>
              handleIssueList(
                {
                  status: argv.status as string | undefined,
                  severity: argv.severity as string | undefined,
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
              y2
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
                  demandOption: true,
                  describe: "Impact description",
                })
                .option("components", {
                  type: "string",
                  array: true,
                  describe: "Affected components",
                })
                .option("related-tickets", {
                  type: "string",
                  array: true,
                  describe: "Related ticket IDs",
                })
                .option("location", {
                  type: "string",
                  array: true,
                  describe: "File locations",
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
              const result = await handleIssueCreate(
                {
                  title: argv.title as string,
                  severity: argv.severity as string,
                  impact: argv.impact as string,
                  components: normalizeArrayOption(
                    argv.components as string[] | undefined,
                  ),
                  relatedTickets: normalizeArrayOption(
                    argv["related-tickets"] as string[] | undefined,
                  ),
                  location: normalizeArrayOption(
                    argv.location as string[] | undefined,
                  ),
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
              y2
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
                .option("resolution", {
                  type: "string",
                  describe: "Resolution description",
                })
                .option("components", {
                  type: "string",
                  array: true,
                  describe: "Affected components",
                })
                .option("related-tickets", {
                  type: "string",
                  array: true,
                  describe: "Related ticket IDs",
                })
                .option("location", {
                  type: "string",
                  array: true,
                  describe: "File locations",
                }),
            ),
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
              const result = await handleIssueUpdate(
                id,
                {
                  status: argv.status as string | undefined,
                  title: argv.title as string | undefined,
                  severity: argv.severity as string | undefined,
                  impact: argv.impact as string | undefined,
                  resolution:
                    argv.resolution === ""
                      ? null
                      : (argv.resolution as string | undefined),
                  components: argv.components
                    ? normalizeArrayOption(argv.components as string[])
                    : undefined,
                  relatedTickets: argv["related-tickets"]
                    ? normalizeArrayOption(argv["related-tickets"] as string[])
                    : undefined,
                  location: argv.location
                    ? normalizeArrayOption(argv.location as string[])
                    : undefined,
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
          "Delete an issue",
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
            await runDeleteCommand(format, false, async (ctx) =>
              handleIssueDelete(id, format, ctx.root),
            );
          },
        )
        .demandCommand(
          1,
          "Specify an issue subcommand: list, get, create, update, delete",
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
          (y2) => addFormatOption(y2),
          async (argv) => {
            const format = parseOutputFormat(argv.format);
            await runReadCommand(format, handlePhaseList);
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
    "Session diff — changes since last snapshot + suggested actions",
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

export function registerSetupSkillCommand(yargs: Argv): Argv {
  return yargs.command(
    "setup-skill",
    "Install the /story skill globally for Claude Code",
    () => {},
    async () => {
      const { handleSetupSkill } = await import("./commands/setup-skill.js");
      await handleSetupSkill();
    },
  );
}
