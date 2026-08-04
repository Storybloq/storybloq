import { resolve, relative, extname } from "node:path";
import { lstat } from "node:fs/promises";
import { ZodError } from "zod";
import {
  TicketIdSchema,
  IssueIdSchema,
  NoteIdSchema,
  LessonIdSchema,
  DateSchema,
  OUTPUT_FORMATS,
  type OutputFormat,
  type ErrorCode,
} from "../models/types.js";
import type { Argv } from "yargs";
import { resolveNodeRoot, checkNodeWritePermission, readOrchestratorConfig } from "../mcp/node-resolution.js";

export class CliValidationError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CliValidationError";
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => i.message).join("; ");
}

export function parseTicketId(raw: string): string {
  const result = TicketIdSchema.safeParse(raw);
  if (!result.success) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid ticket ID "${raw}": ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function parseIssueId(raw: string): string {
  const result = IssueIdSchema.safeParse(raw);
  if (!result.success) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid issue ID "${raw}": ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function parseDate(raw: string): string {
  const result = DateSchema.safeParse(raw);
  if (!result.success) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid date "${raw}": ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function parseOutputFormat(raw: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(raw as OutputFormat)) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid output format "${raw}": must be one of ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return raw as OutputFormat;
}

/** Returns today's date as YYYY-MM-DD using local date components. */
export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Rejects an update that carries nothing to change (ISS-892).
 *
 * `storybloq ticket update T-001` with no other flag, and the MCP equivalent,
 * reported "Updated ticket T-001" at exit 0 while writing a byte-identical file.
 * The same thing happens when a caller passes a field name the tool does not
 * implement, since the unknown key is dropped and what reaches the handler is a
 * bare id. An agent reading that success proceeds on a ledger that never moved.
 *
 * A value counts as supplied when it is neither `undefined` nor `false`. `false`
 * is excluded because the only booleans in these update sets are clear-flags
 * (`clearTags`, `clearDependsOn`, `clearLinks`) which yargs defaults to `false`,
 * so an unset one arrives defined but asks for nothing. `null` DOES count: it is
 * how a caller clears `phase`, `parentTicket`, or `resolution`.
 */
export function assertUpdateHasFields(
  updates: Record<string, unknown>,
  entity: string,
  fieldHint: string,
): void {
  const supplied = Object.values(updates).some((v) => v !== undefined && v !== false);
  if (!supplied) {
    throw new CliValidationError(
      "invalid_input",
      `No fields to update on this ${entity}. Supply at least one of: ${fieldHint}. ` +
        "If you passed a field and still see this, the name was not recognized.",
    );
  }
}

/**
 * Shared help epilogue for every command on the md/json format axis (ISS-910).
 * Lives on the COMMAND builders because a root .epilogue() does not propagate
 * to subcommand --help in yargs 17; attaching it here makes the coverage
 * structural rather than per-command prose.
 */
export const JSON_ENVELOPE_EPILOGUE =
  'JSON output (--format json) is wrapped in a versioned envelope: {"version": 1, "data": ...} on success, ' +
  '{"version": 1, "error": {"code", "message"}} on failure, plus a "warnings" array on partial loads (exit code 3). ' +
  "--raw emits the data payload verbatim instead: errors keep the envelope, partial-load warnings are dropped " +
  "(the exit code still signals them), and commands whose JSON is not the standard envelope reject --raw naming their shape.";

/**
 * Help text for a command whose JSON is NOT the shared envelope (ISS-910).
 *
 * Such a command does not register --raw AT ALL, so strict parsing rejects
 * `--raw` during argument validation, before the handler runs. That ordering
 * is the point: several of these commands mutate (`gc --apply`, `resolve`,
 * `team init/setup/reserve`, `limit-status --cancel`), and rejecting at the
 * output seam instead would let the mutation happen and only then report a
 * raw-mode error, inviting a retry of work that already succeeded.
 */
function deviantShapeEpilogue(jsonShape: string): string {
  return (
    `JSON output (--format json) from this command is ${jsonShape}, NOT the shared ` +
    '{"version": 1, "data": ...} envelope that most commands use. --raw is defined only for ' +
    "the shared envelope and is therefore not accepted by this command; passing it is rejected " +
    "before the command runs."
  );
}

/**
 * Adds the shared --format/--raw options and the envelope epilogue to a yargs
 * command builder. Every command on the standard md/json axis registers
 * through here (ISS-910) so the envelope documentation and the --raw contract
 * cannot drift per command. The session list/show text/json axis and the bus
 * wire format deliberately do NOT use this helper.
 *
 * Pass `jsonShape` for a command whose JSON is knowingly deviant (verified by
 * running it, not assumed): its help then names that shape instead of
 * promising the shared envelope. `test/cli/raw-envelope.e2e.test.ts` pins the
 * annotation against each command's ACTUAL output, so an annotation that
 * stops matching reality fails the suite rather than misleading an operator.
 */
export function addFormatOption<T>(y: Argv<T>): Argv<T & { format: string; raw: boolean }>;
export function addFormatOption<T>(y: Argv<T>, jsonShape: string): Argv<T & { format: string }>;
export function addFormatOption<T>(
  y: Argv<T>,
  jsonShape?: string,
): Argv<T & { format: string; raw: boolean }> | Argv<T & { format: string }> {
  const withFormat = y.option("format", {
    type: "string",
    default: "md",
    choices: ["json", "md"],
    describe: jsonShape
      ? `Output format: md, or json (this command emits ${jsonShape}, not the shared envelope)`
      : 'Output format: md, or json (a versioned {"version": 1, "data": ...} envelope)',
  });

  // No --raw here, so strict parsing rejects it before the handler runs. The
  // overload above keeps the TYPE honest too: a deviant builder must not hand
  // its handler an argv that claims a definite `raw: boolean`.
  if (jsonShape) {
    return withFormat.epilogue(deviantShapeEpilogue(jsonShape)) as Argv<T & { format: string }>;
  }

  return withFormat
    .option("raw", {
      type: "boolean",
      default: false,
      describe: "With --format json: emit the data payload without the envelope",
    })
    .epilogue(JSON_ENVELOPE_EPILOGUE) as Argv<T & { format: string; raw: boolean }>;
}

/**
 * Validates a handover filename for safe filesystem access.
 * Rejects path traversal characters, requires .md extension,
 * and verifies the resolved path stays within handoversDir.
 * Also rejects symlinks via lstat.
 */
export async function parseHandoverFilename(
  raw: string,
  handoversDir: string,
): Promise<string> {
  // Reject dangerous characters
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..") || raw.includes("\0")) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid handover filename "${raw}": contains path traversal characters`,
    );
  }

  // Require .md extension (case-sensitive)
  if (extname(raw) !== ".md") {
    throw new CliValidationError(
      "invalid_input",
      `Invalid handover filename "${raw}": must have .md extension`,
    );
  }

  // Resolve and verify containment using path.relative
  const resolvedDir = resolve(handoversDir);
  const resolvedCandidate = resolve(handoversDir, raw);
  const rel = relative(resolvedDir, resolvedCandidate);
  if (!rel || rel.startsWith("..") || resolve(resolvedDir, rel) !== resolvedCandidate) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid handover filename "${raw}": resolves outside handovers directory`,
    );
  }

  // Reject symlinks (require regular file)
  try {
    const stats = await lstat(resolvedCandidate);
    if (stats.isSymbolicLink()) {
      throw new CliValidationError(
        "invalid_input",
        `Invalid handover filename "${raw}": symlinks not allowed`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) throw err;
    // ENOENT is fine -- file might not exist yet, will fail at read time
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliValidationError(
        "io_error",
        `Cannot check handover file "${raw}": ${(err as Error).message}`,
      );
    }
  }

  return raw;
}

export function parseNoteId(raw: string): string {
  const result = NoteIdSchema.safeParse(raw);
  if (!result.success) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid note ID "${raw}": ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function parseLessonId(raw: string): string {
  const result = LessonIdSchema.safeParse(raw);
  if (!result.success) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid lesson ID "${raw}": ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Normalizes tag values.
 * Non-string items are filtered rather than rejected. CLI callers no longer
 * produce them: array options register as type "string" and are coerced by
 * src/cli/array-options.ts, which rejects a non-string outright. MCP callers are
 * pre-validated by Zod z.array(z.string()). So this filter is now only a
 * backstop, not the tag path's data-loss risk it once was (ISS-886: under the
 * previous type "array" registration, `--tags 2026` parsed as a NUMBER and was
 * silently dropped here).
 * Filters non-strings,
 * trims, lowercases, replaces spaces with hyphens, strips invalid chars,
 * collapses hyphens, deduplicates, and filters empties.
 */
export function normalizeTags(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = item
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Reads all content from stdin (piped input).
 * Throws CliValidationError if stdin is a TTY or content is empty.
 */
export function resolveCliNodeRoot(
  orchestratorRoot: string,
  nodeName: string,
  requireWrite: boolean,
): { ok: true; root: string } | { ok: false; error: string; code: ErrorCode } {
  const resolved = resolveNodeRoot(orchestratorRoot, nodeName);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, code: resolved.errorCode as ErrorCode };
  }
  if (requireWrite && !checkNodeWritePermission(orchestratorRoot)) {
    return {
      ok: false,
      error: "Node writes are disabled. Run: storybloq config set-federation --allow-node-writes",
      code: "invalid_input",
    };
  }
  return { ok: true, root: resolved.root };
}

export async function readStdinContent(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliValidationError(
      "invalid_input",
      "--stdin requires piped input, not a TTY",
    );
  }
  const chunks: Array<Buffer | string> = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer | string);
  }
  const content = Buffer.concat(
    chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
  ).toString("utf-8");
  if (!content.trim()) {
    throw new CliValidationError(
      "invalid_input",
      "Stdin content is empty",
    );
  }
  return content;
}
