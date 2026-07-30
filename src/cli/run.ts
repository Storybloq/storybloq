import { join } from "node:path";
import { discoverProjectRoot, loadProject } from "../core/index.js";
import { ProjectLoaderError, INTEGRITY_WARNING_TYPES, type LoadWarning } from "../core/errors.js";
import { ExitCode, formatError } from "../core/output-formatter.js";
import { CliValidationError } from "./helpers.js";
import { RefResolutionError } from "../core/ref-normalization.js";
import type { OutputFormat } from "../models/types.js";
import type { CommandContext, CommandResult, DeleteCommandContext } from "./types.js";
import { transformForRawMode } from "./raw-mode.js";

// Re-export types so existing test imports that reference run.ts still resolve.
export type { CommandContext, CommandResult, DeleteCommandContext } from "./types.js";

// Handle EPIPE on stdout globally (piping to head, etc.)
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exitCode = ExitCode.OK;
    return;
  }
  // Other stdout errors — set exit code but don't crash
  process.exitCode = ExitCode.USER_ERROR;
});

/**
 * Writes output to stdout with EPIPE handling.
 * Treats EPIPE as controlled termination (e.g. piping to head).
 */
export function writeOutput(text: string): void {
  // ISS-910: the single seam where --raw unwraps the standard JSON envelope
  // (identity unless raw mode is active).
  const finalText = transformForRawMode(text);
  try {
    process.stdout.write(finalText + "\n");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      process.exitCode = ExitCode.OK;
      return;
    }
    throw err;
  }
}

/** Returns true if any warnings are integrity-level (not cosmetic). */
function hasIntegrityWarnings(warnings: readonly LoadWarning[]): boolean {
  return warnings.some((w) =>
    (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
  );
}

/**
 * Shared pipeline for all read commands:
 *   1. Discover project root
 *   2. Load project (non-strict)
 *   3. Call handler with CommandContext
 *   4. If handler returned OK and integrity warnings present, upgrade to PARTIAL
 *   5. Print output to stdout
 *   6. Set exit code
 */
export async function runReadCommand(
  format: OutputFormat,
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult,
): Promise<void> {
  try {
    const root = discoverProjectRoot();
    if (!root) {
      writeOutput(
        formatError("not_found", "No .story/ project found. Run `storybloq init` first.", format),
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const { state, warnings } = await loadProject(root);
    const handoversDir = join(root, ".story", "handovers");

    const result = await handler({ state, warnings, root, handoversDir, format });
    writeOutput(result.output);

    let exitCode = result.exitCode ?? ExitCode.OK;
    // Upgrade to PARTIAL only for integrity warnings, not cosmetic
    if (exitCode === ExitCode.OK && hasIntegrityWarnings(warnings)) {
      exitCode = ExitCode.PARTIAL;
    }
    process.exitCode = exitCode;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof RefResolutionError) {
      const code = err.reason === "missing" ? "not_found" : "invalid_input";
      writeOutput(formatError(code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    // Unknown error -- catch-all
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format));
    process.exitCode = ExitCode.USER_ERROR;
  }
}

export async function runReadCommandWithRoot(
  format: OutputFormat,
  explicitRoot: string,
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult,
): Promise<void> {
  try {
    const { state, warnings } = await loadProject(explicitRoot);
    const handoversDir = join(explicitRoot, ".story", "handovers");

    const result = await handler({ state, warnings, root: explicitRoot, handoversDir, format });
    writeOutput(result.output);

    let exitCode = result.exitCode ?? ExitCode.OK;
    if (exitCode === ExitCode.OK && hasIntegrityWarnings(warnings)) {
      exitCode = ExitCode.PARTIAL;
    }
    process.exitCode = exitCode;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof RefResolutionError) {
      const code = err.reason === "missing" ? "not_found" : "invalid_input";
      writeOutput(formatError(code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format));
    process.exitCode = ExitCode.USER_ERROR;
  }
}

/**
 * Pipeline for delete commands. Non-strict loading so deletes work on
 * partially corrupt projects. When integrity warnings present and
 * force is false, errors out.
 */
export async function runDeleteCommand(
  format: OutputFormat,
  force: boolean,
  handler: (ctx: DeleteCommandContext) => Promise<CommandResult> | CommandResult,
): Promise<void> {
  try {
    const root = discoverProjectRoot();
    if (!root) {
      writeOutput(
        formatError("not_found", "No .story/ project found. Run `storybloq init` first.", format),
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const { state, warnings } = await loadProject(root);
    const handoversDir = join(root, ".story", "handovers");

    // Non-strict load: if integrity warnings present, require --force
    if (!force && hasIntegrityWarnings(warnings)) {
      writeOutput(
        formatError(
          "project_corrupt",
          "Project has integrity issues. Use --force to delete anyway.",
          format,
        ),
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const result = await handler({ state, warnings, root, handoversDir, format, force });
    writeOutput(result.output);
    process.exitCode = result.exitCode ?? ExitCode.OK;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof RefResolutionError) {
      const code = err.reason === "missing" ? "not_found" : "invalid_input";
      writeOutput(formatError(code, err.message, format));
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format));
    process.exitCode = ExitCode.USER_ERROR;
  }
}
