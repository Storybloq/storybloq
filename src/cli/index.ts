#!/usr/bin/env node

export {};

// --mcp flag: start MCP server instead of CLI.
// Enables one-line registration: claude mcp add storybloq -- npx -y @storybloq/storybloq --mcp
if (!process.argv.includes("--mcp")) {
  await runCli();
} else {
  await import("../mcp/index.js");
}

// preCommandHousekeeping lives in ./housekeeping.ts so its behavior can be
// exercised by tests without triggering the top-level `runCli()` execution
// in this module.

/**
 * ISS-570 G1: one-line stderr banner when a newer @storybloq/storybloq
 * is available. Reads cache only; never blocks exit on network. The
 * background refresh from preCommandHousekeeping primes the cache for
 * the next invocation.
 */
async function emitUpdateBannerIfStale(version: string): Promise<void> {
  if (!version || version === "0.0.0-dev") return;
  try {
    const { readUpdateCacheSync, formatUpdateBanner } = await import("../core/update-check.js");
    const banner = formatUpdateBanner(readUpdateCacheSync(version));
    if (banner) process.stderr.write(banner);
  } catch {
    // Best-effort.
  }
}

async function runCli(): Promise<void> {
  const { default: yargs } = await import("yargs");
  const { hideBin } = await import("yargs/helpers");
  const { ExitCode, formatError } = await import("../core/output-formatter.js");
  const { writeOutput } = await import("./run.js");
  const {
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
    registerNoteCommand,
    registerLessonCommand,
    registerRecommendCommand,
    registerReferenceCommand,
    registerSelftestCommand,
    registerSetupSkillCommand,
    registerHookStatusCommand,
    registerConfigCommand,
    registerSessionCommand,
    registerRepairCommand,
  } = await import("./register.js");

  // Version injected at build time by tsup define
  const version = process.env.CLAUDESTORY_VERSION ?? "0.0.0-dev";

  // ISS-570: silent skill-dir refresh if the CLI version changed + schedule
  // a background update check so the next invocation's banner is fresh.
  const { preCommandHousekeeping } = await import("./housekeeping.js");
  await preCommandHousekeeping(version);

  class HandledError extends Error {
    constructor() {
      super("HANDLED_ERROR");
      this.name = "HandledError";
    }
  }

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
    .scriptName("storybloq")
    .version(version)
    .strict()
    .demandCommand(1, "Specify a command. Run with --help for available commands.")
    .help()
    .fail((msg, err) => {
      if (err) throw err;
      writeOutput(formatError("invalid_input", msg ?? "Unknown error", errorFormat));
      process.exitCode = ExitCode.USER_ERROR;
      throw new HandledError();
    });

  cli = registerInitCommand(cli);
  cli = registerStatusCommand(cli);
  cli = registerPhaseCommand(cli);
  cli = registerTicketCommand(cli);
  cli = registerIssueCommand(cli);
  cli = registerNoteCommand(cli);
  cli = registerLessonCommand(cli);
  cli = registerHandoverCommand(cli);
  cli = registerBlockerCommand(cli);
  cli = registerValidateCommand(cli);
  cli = registerRepairCommand(cli);
  cli = registerSnapshotCommand(cli);
  cli = registerRecapCommand(cli);
  cli = registerExportCommand(cli);
  cli = registerRecommendCommand(cli);
  cli = registerReferenceCommand(cli);
  cli = registerSelftestCommand(cli);
  cli = registerSetupSkillCommand(cli);
  cli = registerHookStatusCommand(cli);
  cli = registerConfigCommand(cli);
  cli = registerSessionCommand(cli);

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

  // ISS-570 G1: banner is the last thing the CLI does, after the command's
  // own output. Prints to stderr so it never interferes with structured
  // JSON on stdout.
  await emitUpdateBannerIfStale(version);
}
