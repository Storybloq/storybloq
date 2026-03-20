#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ExitCode, formatError } from "../core/output-formatter.js";
import { writeOutput } from "./run.js";
import {
  registerInitCommand,
  registerStatusCommand,
  registerPhaseCommand,
  registerTicketCommand,
  registerIssueCommand,
  registerHandoverCommand,
  registerBlockerCommand,
  registerValidateCommand,
  registerSnapshotCommand,
  registerRecapCommand,
  registerExportCommand,
} from "./register.js";

// Version injected at build time by tsup define
const version = process.env.CLAUDESTORY_VERSION ?? "0.0.0-dev";

// Error class for errors already handled by .fail()
class HandledError extends Error {
  constructor() {
    super("HANDLED_ERROR");
    this.name = "HandledError";
  }
}

// Sniff --format from raw argv for error formatting before yargs parses
const rawArgs = hideBin(process.argv);
function sniffFormat(args: string[]): "json" | "md" {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1] === "json") return "json";
    if (args[i]?.startsWith("--format=") && args[i]!.slice("--format=".length) === "json") return "json";
  }
  return "md";
}
const errorFormat = sniffFormat(rawArgs);

let cli = yargs(rawArgs)
  .scriptName("claudestory")
  .version(version)
  .strict()
  .demandCommand(1, "Specify a command. Run with --help for available commands.")
  .help()
  .fail((msg, err) => {
    // .fail() is the single owner of yargs validation error output
    if (err) throw err; // Re-throw non-yargs errors for top-level catch
    // Yargs validation error (missing args, unknown command)
    writeOutput(formatError("invalid_input", msg ?? "Unknown error", errorFormat));
    process.exitCode = ExitCode.USER_ERROR;
    throw new HandledError();
  });

cli = registerInitCommand(cli);
cli = registerStatusCommand(cli);
cli = registerPhaseCommand(cli);
cli = registerTicketCommand(cli);
cli = registerIssueCommand(cli);
cli = registerHandoverCommand(cli);
cli = registerBlockerCommand(cli);
cli = registerValidateCommand(cli);
cli = registerSnapshotCommand(cli);
cli = registerRecapCommand(cli);
cli = registerExportCommand(cli);

// Top-level error handling: both sync try-catch and async .catch() are needed.
// yargs' parseAsync() calls parse() synchronously — if .fail() throws during
// validation (missing args, unknown commands), it escapes as a synchronous throw
// before a promise exists. The outer try-catch catches that. The .catch() handles
// rejections from async command handlers.
function handleUnexpectedError(err: unknown): void {
  if (err instanceof HandledError) return;
  const message = err instanceof Error ? err.message : String(err);
  writeOutput(formatError("io_error", message, errorFormat));
  process.exitCode = ExitCode.USER_ERROR;
}

try {
  await cli.parseAsync().catch(handleUnexpectedError);
} catch (err: unknown) {
  handleUnexpectedError(err);
}
