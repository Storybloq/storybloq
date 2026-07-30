/**
 * --raw: emit the JSON data payload without the envelope (ISS-910).
 *
 * `--format json` wraps every standard payload in {"version": 1, "data": ...}
 * and an operator's parser broke on day one because nothing documented it.
 * The envelope is now documented structurally (the shared --format option's
 * describe text and epilogue, plus the generated CLI reference), and --raw
 * exists for parsers that want the payload alone.
 *
 * --raw is DEFINED ONLY for the standard envelope. The contract, enforced
 * here at the single write seam rather than per-command:
 *
 * - {"version": 1, "data": ...}                -> data, verbatim
 * - {"version": 1, "data": ..., "warnings"}    -> data; the PARTIAL exit code
 *   (3) still signals the warnings, so the signal is not lost, only the prose
 * - {"version": 1, "error": ...}               -> unchanged; an error has no
 *   data payload to unwrap and parsers must handle failure anyway
 * - anything else (gc/reserve/conflicts-style shapes, non-JSON text) ->
 *   REJECTED with an error naming the actual top-level shape. Never two
 *   silently different top-level shapes from one flag.
 *
 * Module state, configured once per process by the root middleware: the CLI
 * is a run-once process and the write seam (writeOutput) has no access to
 * argv. Tests reset via resetRawMode().
 */
import { errorEnvelope, ExitCode } from "../core/output-formatter.js";

let active = false;
let rejectionPending = false;

/**
 * Phrased to not BEGIN with the flag: this string is rendered through the
 * Markdown error formatter, which escapes a line-leading "-" as "\-", so a
 * message starting with "--raw" reaches the operator as "\--raw".
 */
export const RAW_REQUIRES_JSON =
  "The --raw flag requires --format json: it unwraps the JSON envelope and has no meaning for other formats.";

/**
 * Pure predicate for the root middleware: `true`, or the message describing
 * the misuse. Returning rather than throwing is deliberate -- the caller
 * reports it directly so the envelope is classified invalid_input and printed
 * exactly once. See the middleware comment in cli/index.ts for why neither
 * .check() nor a .fail() branch produces that outcome.
 */
export function checkRawMode(argv: { raw?: unknown; format?: unknown }): true | string {
  return argv.raw === true && argv.format !== "json" ? RAW_REQUIRES_JSON : true;
}

/**
 * Called from the root yargs middleware on every invocation. Never throws:
 * `active` requires BOTH the flag and json, so even if a caller reaches the
 * seam before validation rejects, raw mode is inert for a non-json format.
 */
export function configureRawMode(rawFlag: unknown, format: unknown): void {
  active = rawFlag === true && format === "json";
  rejectionPending = false;
}

/**
 * True when a raw-mode rejection was emitted this run; the CLI entry point
 * escalates the exit code AFTER command runners have set theirs, so a
 * rejection cannot be overwritten back to success.
 */
export function rawRejectionPending(): boolean {
  return rejectionPending;
}

/** Test seam. */
export function resetRawMode(): void {
  active = false;
  rejectionPending = false;
}

export const RAW_REJECTION_EXIT = ExitCode.USER_ERROR;

/**
 * Applied by writeOutput to every line of command output. Identity unless
 * raw mode is active.
 */
export function transformForRawMode(text: string): string {
  if (!active) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rejectionPending = true;
    return JSON.stringify(
      errorEnvelope(
        "invalid_input",
        "--raw is defined only for the standard {version, data} JSON envelope, but this command emitted non-JSON output. Run without --raw.",
      ),
      null,
      2,
    );
  }

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed).sort();
    const version = (parsed as Record<string, unknown>).version;
    if (version === 1 && (sameKeys(keys, ["data", "version"]) || sameKeys(keys, ["data", "version", "warnings"]))) {
      return JSON.stringify((parsed as Record<string, unknown>).data, null, 2);
    }
    if (version === 1 && sameKeys(keys, ["error", "version"])) {
      // Errors keep the envelope: there is no data payload to unwrap.
      return text;
    }
    rejectionPending = true;
    return JSON.stringify(
      errorEnvelope(
        "invalid_input",
        `--raw is defined only for the standard {version, data} JSON envelope; this command emits a JSON shape with top-level keys {${Object.keys(parsed).join(", ")}}. Run without --raw to get that shape verbatim.`,
      ),
      null,
      2,
    );
  }

  rejectionPending = true;
  return JSON.stringify(
    errorEnvelope(
      "invalid_input",
      "--raw is defined only for the standard {version, data} JSON envelope, but this command emitted a bare JSON value. Run without --raw.",
    ),
    null,
    2,
  );
}

function sameKeys(sortedKeys: readonly string[], expected: readonly string[]): boolean {
  return sortedKeys.length === expected.length && sortedKeys.every((k, i) => k === expected[i]);
}
