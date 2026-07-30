/**
 * Side-effect-free type exports for CLI command handlers.
 *
 * MCP imports handler modules directly. Those modules must NOT transitively
 * load src/cli/run.ts, which registers a module-scope process.stdout EPIPE
 * listener that would corrupt the JSON-RPC channel. Handler files import
 * types from THIS module instead.
 */
import type { ExitCodeValue } from "../core/output-formatter.js";
import type { OutputFormat } from "../models/types.js";
import type { ProjectState } from "../core/project-state.js";
import type { LoadWarning } from "../core/errors.js";

/** Error codes that can appear on a handler result (narrowed from ErrorCode). */
export type ResultErrorCode = "not_found" | "invalid_input" | "io_error" | "project_corrupt" | "version_mismatch";

/** Context provided to every command handler. */
export interface CommandContext {
  readonly state: ProjectState;
  readonly warnings: readonly LoadWarning[];
  readonly root: string;
  readonly handoversDir: string;
  readonly format: OutputFormat;
}

/** Result returned by a command handler. */
export interface CommandResult {
  readonly output: string;
  readonly exitCode?: ExitCodeValue;
  /** Structured error code for MCP classification. CLI ignores this field. */
  readonly errorCode?: ResultErrorCode;
  /**
   * Error flag for MCP adapters (session_report sets it; the adapter maps it
   * to the MCP result's isError). CLI ignores this field; exitCode is the
   * CLI-side error signal.
   */
  readonly isError?: boolean;
}

/** Delete command context includes force flag. */
export interface DeleteCommandContext extends CommandContext {
  readonly force: boolean;
}

export type { ExitCodeValue } from "../core/output-formatter.js";
