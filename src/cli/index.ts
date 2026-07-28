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
  const { takeArrayOptionError, resetArrayOptionError } = await import("./array-options.js");
  const {
    registerInitCommand,
    registerBusCommand,
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
    registerDispatchCommand,
    registerReferenceCommand,
    registerSelftestCommand,
    registerCodexReviewCommand,
    registerSetupCommand,
    registerSetupSkillCommand,
    registerHookStatusCommand,
    registerHookBusToolCommand,
    registerWakerRunCommand,
    registerLimitStatusCommand,
    registerConfigCommand,
    registerSessionCommand,
    registerRepairCommand,
    registerReconcileCommand,
    registerConflictsCommand,
    registerResolveCommand,
    registerGcCommand,
    registerMergeDriverCommand,
    registerTeamCommand,
    registerMigrateCommand,
    registerNodeCommand,
    registerFeedbackCommand,
  } = await import("./register.js");

  // Version injected at build time by tsup define
  const version = process.env.STORYBLOQ_VERSION ?? "0.0.0-dev";

  // ISS-736 / ISS-777: some entry points run programmatically many times and
  // must not do per-invocation housekeeping (awaited skill refresh + a
  // background npm-registry fetch): the git merge driver (spawned once per
  // merged .story file) and the Claude Code hooks (hook-status Stop hook,
  // session compact-prepare/resume-prompt). shouldSkipHousekeeping is the pure
  // predicate covering them; interactive commands keep housekeeping.
  const dispatchedArgv = hideBin(process.argv);
  const dispatchedCommand = dispatchedArgv[0];
  const { shouldSkipHousekeeping } = await import("./housekeeping.js");

  // ISS-570: silent skill-dir refresh if the CLI version changed + schedule
  // a background update check so the next invocation's banner is fresh.
  if (!shouldSkipHousekeeping(dispatchedArgv)) {
    const { preCommandHousekeeping } = await import("./housekeeping.js");
    await preCommandHousekeeping(version, dispatchedArgv);
  }

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
      // Array-option policies run in yargs coerce callbacks. yargs wraps whatever
      // they throw in its own YError, discarding the class and its code, so an
      // `err instanceof CliValidationError` test here would never match and the
      // rethrow below would report user input as io_error. takeArrayOptionError
      // recovers the original by message. Scoped to array options only: every
      // other error class, including plain Errors from .check(), keeps its path.
      const arrayOptionError = err ? takeArrayOptionError(msg ?? "") : null;
      if (arrayOptionError) {
        writeOutput(formatError(arrayOptionError.code, arrayOptionError.message, errorFormat));
        process.exitCode = ExitCode.USER_ERROR;
        throw new HandledError();
      }
      if (err) throw err;
      writeOutput(formatError("invalid_input", msg ?? "Unknown error", errorFormat));
      process.exitCode = ExitCode.USER_ERROR;
      throw new HandledError();
    });

  cli = registerInitCommand(cli);
  cli = registerBusCommand(cli);
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
  cli = registerReconcileCommand(cli);
  cli = registerConflictsCommand(cli);
  cli = registerResolveCommand(cli);
  cli = registerGcCommand(cli);
  cli = registerMergeDriverCommand(cli);
  cli = registerTeamCommand(cli);
  cli = registerMigrateCommand(cli);
  cli = registerSnapshotCommand(cli);
  cli = registerRecapCommand(cli);
  cli = registerExportCommand(cli);
  cli = registerRecommendCommand(cli);
  cli = registerDispatchCommand(cli);
  cli = registerReferenceCommand(cli);
  cli = registerSelftestCommand(cli);
  cli = registerCodexReviewCommand(cli);
  cli = registerSetupCommand(cli);
  cli = registerSetupSkillCommand(cli);
  cli = registerHookStatusCommand(cli);
  cli = registerHookBusToolCommand(cli);
  cli = registerWakerRunCommand(cli);
  cli = registerLimitStatusCommand(cli);
  cli = registerConfigCommand(cli);
  cli = registerNodeCommand(cli);
  cli = registerSessionCommand(cli);
  cli = registerFeedbackCommand(cli);

  function handleUnexpectedError(err: unknown): void {
    if (err instanceof HandledError) return;
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, errorFormat));
    process.exitCode = ExitCode.USER_ERROR;
  }

  try {
    // Bound the array-option error slot to this parse: clear before so no stale
    // entry can be matched, and after so nothing outlives the parse that set it.
    resetArrayOptionError();
    await cli.parseAsync().catch(handleUnexpectedError);
  } catch (err: unknown) {
    handleUnexpectedError(err);
  } finally {
    resetArrayOptionError();
  }

  // ISS-570 G1: banner is the last thing the CLI does, after the command's
  // own output. Prints to stderr so it never interferes with structured
  // JSON on stdout. ISS-736: gated on TTY/env/command via the pure guard.
  const { shouldEmitUpdateBanner } = await import("../core/update-check.js");
  if (shouldEmitUpdateBanner({ stderrIsTTY: process.stderr.isTTY === true, env: process.env, command: dispatchedCommand })) {
    await emitUpdateBannerIfStale(version);
  }
}
