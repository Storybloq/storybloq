import { join } from "node:path";
import { cliBannerFor, cliStatusPushesFor } from "../core/session-intel/push.js";
import { discoverProjectRoot, loadProject } from "../core/index.js";
import { ProjectLoaderError, INTEGRITY_WARNING_TYPES, type LoadWarning } from "../core/errors.js";
import { ExitCode, formatError } from "../core/output-formatter.js";
import { CliValidationError } from "./helpers.js";
import { RefResolutionError } from "../core/ref-normalization.js";
import type { OutputFormat } from "../models/types.js";
import type { CommandContext, CommandResult, DeleteCommandContext } from "./types.js";
import { transformForRawMode } from "./raw-mode.js";
import { sanitizeTerminalDocument } from "../core/display-text.js";
import { runWithBoardWriteContext } from "../core/board-write-recorder.js";
import { reportBoardWrite, type BoardWriteReport } from "../core/board-git-state.js";

// Re-export types so existing test imports that reference run.ts still resolve.
export type { CommandContext, CommandResult, DeleteCommandContext } from "./types.js";

// Handle EPIPE on stdout globally (piping to head, etc.)
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exitCode = ExitCode.OK;
    return;
  }
  // Other stdout errors -- set exit code but don't crash
  process.exitCode = ExitCode.USER_ERROR;
});

/**
 * The format of bytes rendered by the `=== "json"` rule that
 * `noProjectFoundOutput` and the `(argv.format as ...) ?? "md"` handlers
 * follow: JSON exactly when the option says json, Markdown otherwise.
 */
export function outputFormatOf(raw: unknown): OutputFormat {
  return raw === "json" ? "json" : "md";
}

/**
 * Writes output to stdout with EPIPE handling.
 * Treats EPIPE as controlled termination (e.g. piping to head).
 *
 * `format` is the format of `text` as written, stated by the caller (ISS-1281).
 * It is not the parsed --format option: status --compact and codex-review write
 * JSON whatever that says.
 */
export function writeOutput(text: string, format: OutputFormat): void {
  // ISS-910: the single seam where --raw unwraps the standard JSON envelope
  // (identity unless raw mode is active). It parses the original bytes, so it
  // runs before the sanitizer.
  const unwrapped = transformForRawMode(text);
  // ISS-1281: no terminal control from a repo-sourced field reaches the
  // terminal through Markdown. JSON is never touched.
  const finalText = format === "json" ? unwrapped : sanitizeTerminalDocument(unwrapped);
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

/**
 * T-499: the token-pressure banner for the caller's own session, under the
 * binding rule. md is appended to stdout through `writeOutput`; json emits
 * ONE line on STDERR so the stdout envelope and `--raw` stay parseable. Hook
 * subcommands never route through these pipelines, so they never get one.
 * Best-effort: any failure leaves the output exactly as written.
 */
function emitCliBanner(root: string, format: OutputFormat, pushes: ReadCommandPushes = {}): void {
  try {
    const cliFormat = format === "json" ? "json" : "md";
    // T-501: the priming call (`storybloq status`) derives BOTH pushes from
    // one acquisition under one deadline; every other read command keeps the
    // pressure banner alone. Two separate acquisitions would double the
    // permitted push overhead and could describe two different samples.
    const out = pushes.usageAdvisory
      ? cliStatusPushesFor(root, cliFormat, { cwd: process.cwd() })
      : (() => {
          const banner = cliBannerFor(root, cliFormat, { cwd: process.cwd() });
          return { stdout: banner.stdout ? [banner.stdout] : [], stderr: banner.stderr ? [banner.stderr] : [] };
        })();
    for (const line of out.stdout) writeOutput(`\n${line}`, cliFormat);
    for (const line of out.stderr) process.stderr.write(`${line}\n`);
  } catch {
    // never
  }
}

/** T-501: which optional session-intel pushes a read command may emit. */
export interface ReadCommandPushes {
  readonly usageAdvisory?: boolean;
}

/**
 * T-476 ruling #9 fix: `CommandResult.warnings` previously only flipped the
 * exit code to PARTIAL -- the warning TEXT itself never reached the CLI
 * output, so a corrupt ruling file was invisible short of re-running
 * `storybloq validate`. `raw-mode.ts` already documents and tests a
 * `{version, data, warnings}` JSON shape (`--raw is defined only for the
 * standard {version, data} JSON envelope, but ... warnings` -- see its
 * `transformForRawMode`), so this completes that pre-existing, forward-
 * declared contract rather than inventing a new one: for JSON, `warnings` is
 * injected as a sibling of `data`, never nested inside it, and only when the
 * output is that exact standard envelope shape (an error envelope, or any
 * other JSON shape, is left untouched -- never corrupt a shape this wasn't
 * designed for). For markdown, the text is appended as a plain warning line.
 */
export function applyHandlerWarnings(output: string, format: OutputFormat, warnings: readonly string[]): string {
  if (warnings.length === 0) return output;
  if (format !== "json") {
    return `${output}\n\nWarning: ${warnings.join("; ")}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return output;
  const keys = Object.keys(parsed as Record<string, unknown>).sort();
  const isStandardEnvelope = (parsed as Record<string, unknown>).version === 1
    && keys.length === 2 && keys[0] === "data" && keys[1] === "version";
  if (!isStandardEnvelope) return output;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), warnings }, null, 2);
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
  pushes: ReadCommandPushes = {},
): Promise<void> {
  try {
    const root = discoverProjectRoot();
    if (!root) {
      writeOutput(
        formatError("not_found", "No .story/ project found. Run `storybloq init` first.", format),
        format,
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const { state, warnings } = await loadProject(root);
    const handoversDir = join(root, ".story", "handovers");

    const result = await handler({ state, warnings, root, handoversDir, format });
    writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
    emitCliBanner(root, format, pushes);

    let exitCode = result.exitCode ?? ExitCode.OK;
    // Upgrade to PARTIAL for integrity warnings OR handler-produced render
    // warnings (T-476 ruling #9) -- never for cosmetic ones, and never
    // overriding a handler's own non-OK exit code either way.
    if (exitCode === ExitCode.OK && (hasIntegrityWarnings(warnings) || (result.warnings?.length ?? 0) > 0)) {
      exitCode = ExitCode.PARTIAL;
    }
    process.exitCode = exitCode;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof RefResolutionError) {
      const code = err.reason === "missing" ? "not_found" : "invalid_input";
      writeOutput(formatError(code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    // Unknown error -- catch-all
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}

export async function runReadCommandWithRoot(
  format: OutputFormat,
  explicitRoot: string,
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult,
  pushes: ReadCommandPushes = {},
): Promise<void> {
  try {
    const { state, warnings } = await loadProject(explicitRoot);
    const handoversDir = join(explicitRoot, ".story", "handovers");

    const result = await handler({ state, warnings, root: explicitRoot, handoversDir, format });
    writeOutput(applyHandlerWarnings(result.output, format, result.warnings ?? []), format);
    emitCliBanner(explicitRoot, format, pushes);

    let exitCode = result.exitCode ?? ExitCode.OK;
    if (exitCode === ExitCode.OK && (hasIntegrityWarnings(warnings) || (result.warnings?.length ?? 0) > 0)) {
      exitCode = ExitCode.PARTIAL;
    }
    process.exitCode = exitCode;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof RefResolutionError) {
      const code = err.reason === "missing" ? "not_found" : "invalid_input";
      writeOutput(formatError(code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}

/**
 * Pipeline for delete commands. Non-strict loading so deletes work on
 * partially corrupt projects. When integrity warnings present and
 * force is false, errors out.
 */
/** The parsed argv a board write command needs: `--commit` and its command path. */
export interface BoardWriteArgv {
  readonly commit?: unknown;
  readonly _?: ReadonlyArray<string | number>;
}

type BoardWriteResult = { readonly output: string; readonly exitCode?: number; readonly errorCode?: string; readonly isError?: boolean };

/**
 * ISS-1107: the git report on a board write's output. Markdown gets the same
 * `Git:` lines as the MCP reply; JSON gets additive `data.git`,
 * `data.gitCommit` and `data.gitUnavailable` keys and never a text line. Any
 * other output shape is left exactly as it was.
 */
export function applyBoardGitReport(output: string, format: OutputFormat, report: BoardWriteReport): string {
  if (format !== "json") return report.lines.length > 0 ? `${output}\n\n${report.lines.join("\n")}` : output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return output;
  const envelope = parsed as Record<string, unknown>;
  const data = envelope.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return output;
  return JSON.stringify({
    ...envelope,
    data: {
      ...(data as Record<string, unknown>),
      git: report.git,
      ...(report.gitCommit ? { gitCommit: report.gitCommit } : {}),
      ...(report.gitUnavailable ? { gitUnavailable: report.gitUnavailable } : {}),
    },
  }, null, 2);
}

/**
 * ISS-1107: runs a board write command's handler with a recorder, then reports
 * the git state of exactly the files it wrote (and commits them for
 * `--commit`). Only an explicitly successful result is reported. A failed
 * optional commit never changes the exit status: the write succeeded, and the
 * outcome is in the output.
 */
export async function runBoardWrite<R extends BoardWriteResult>(
  argv: BoardWriteArgv,
  format: OutputFormat,
  fn: () => Promise<R> | R,
): Promise<R> {
  const tool = (argv._ ?? []).map(String).join(" ");
  const { value: result, context } = await runWithBoardWriteContext(tool, argv.commit === true, async () => fn());
  if (result.errorCode || result.isError || (result.exitCode !== undefined && result.exitCode !== 0)) return result;
  const report = await reportBoardWrite(context);
  if (report.git.length === 0 && !report.gitCommit) return result;
  return { ...result, output: applyBoardGitReport(result.output, format, report) };
}

export async function runDeleteCommand(
  argv: BoardWriteArgv,
  format: OutputFormat,
  force: boolean,
  handler: (ctx: DeleteCommandContext) => Promise<CommandResult> | CommandResult,
): Promise<void> {
  try {
    const root = discoverProjectRoot();
    if (!root) {
      writeOutput(
        formatError("not_found", "No .story/ project found. Run `storybloq init` first.", format),
        format,
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
        format,
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }

    const result = await runBoardWrite(argv, format, () => handler({ state, warnings, root, handoversDir, format, force }));
    writeOutput(result.output, format);
    process.exitCode = result.exitCode ?? ExitCode.OK;
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof CliValidationError) {
      writeOutput(formatError(err.code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    if (err instanceof RefResolutionError) {
      const code = err.reason === "missing" ? "not_found" : "invalid_input";
      writeOutput(formatError(code, err.message, format), format);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(formatError("io_error", message, format), format);
    process.exitCode = ExitCode.USER_ERROR;
  }
}
