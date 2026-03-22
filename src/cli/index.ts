#!/usr/bin/env node

export {};

// --mcp flag: start MCP server instead of CLI.
// Enables one-line registration: claude mcp add claudestory -- npx -y @anthropologies/claudestory --mcp
if (!process.argv.includes("--mcp")) {
  await runCli();
} else {
  await import("../mcp/index.js");
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
    registerReferenceCommand,
    registerSetupSkillCommand,
  } = await import("./register.js");

  // Version injected at build time by tsup define
  const version = process.env.CLAUDESTORY_VERSION ?? "0.0.0-dev";

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
    .scriptName("claudestory")
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
  cli = registerHandoverCommand(cli);
  cli = registerBlockerCommand(cli);
  cli = registerValidateCommand(cli);
  cli = registerSnapshotCommand(cli);
  cli = registerRecapCommand(cli);
  cli = registerExportCommand(cli);
  cli = registerReferenceCommand(cli);
  cli = registerSetupSkillCommand(cli);

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
}
