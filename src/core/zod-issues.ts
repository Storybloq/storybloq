/**
 * Structured zod validation failures (ISS-897, N-097 operator 4).
 *
 * Every session read in this codebase ends in `SessionStateSchema.safeParse`,
 * and every failure path throws away `error.issues` and reports the constant
 * string "corrupt or unreadable". An operator meeting that message has no way
 * to learn WHICH field failed short of extracting the schema by hand, which is
 * a twenty-minute archaeology for what is usually a one-line fix. zod already
 * returns the field path, the expected type, and the received value; this
 * module is the carrier that stops them being discarded.
 *
 * Deliberately not merged with `summarizeSchemaError` in `ledger-integrity.ts`.
 * That one produces a display string for a finding whose consumer never needs
 * the parts, and its exact output is pinned by validate's tests; this one is
 * structured because the session surfaces (`session list --format json`,
 * `session_report`) have to carry the fields separately.
 */
import type { ZodError, ZodIssue } from "zod";
import { sanitizeDisplayText } from "./display-text.js";
import { escapeMarkdownDocumentStrict } from "./output-formatter.js";

export interface SchemaIssue {
  /** Dotted field path with array indices, e.g. `lensReviewHistory[2].disposition`. Empty string at the root. */
  readonly path: string;
  /** The type or enum the schema wanted, when zod names one. */
  readonly expected?: string;
  /** What was actually there, when zod names it. */
  readonly received?: string;
  /**
   * zod's own message, the fallback for codes that name neither side.
   *
   * BOUNDED, not verbatim: zod echoes a received value into its text, so this
   * carries untrusted content and is capped like every other field here, with
   * the original length reported in the suffix when it is cut.
   */
  readonly message: string;
}

/**
 * `["lensReviewHistory", 2, "disposition"]` -> `"lensReviewHistory[2].disposition"`.
 *
 * A key that is not a plain identifier goes in quoted brackets instead of after
 * a dot. Session state carries `z.record` fields whose keys are arbitrary
 * strings, so joining unconditionally with dots renders `["stages", "a.b"]` and
 * `["stages", "a", "b"]` identically -- and this string's whole job is naming
 * the ONE field to go and fix, on the surface an operator reaches after a
 * schema failure.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function renderPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
      continue;
    }
    const key = String(segment);
    if (PLAIN_IDENTIFIER.test(key)) {
      out += out.length > 0 ? `.${key}` : key;
    } else {
      // `JSON.stringify` escapes the quotes and backslashes the key may carry,
      // so the rendering stays unambiguous rather than merely different.
      out += `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

function toSchemaIssue(issue: ZodIssue): SchemaIssue {
  // `invalid_type` carries `expected`/`received` directly. `invalid_enum_value`
  // and `invalid_literal` carry the received value plus the permitted set under
  // a different key, so the expected side is reconstructed rather than dropped.
  const raw = issue as ZodIssue & {
    expected?: unknown;
    received?: unknown;
    options?: unknown;
  };
  const options = Array.isArray(raw.options) ? (raw.options as unknown[]) : null;
  // `invalid_literal` carries a NON-string `expected` for a numeric or boolean
  // literal (`schemaVersion` is the concrete case), so testing only for a string
  // dropped the expected side for exactly the fields where it is most useful.
  const expected = typeof raw.expected === "string"
    ? raw.expected
    : raw.expected !== undefined
      ? JSON.stringify(raw.expected)
      : options
        ? options.map((o) => JSON.stringify(o)).join(" | ")
        : undefined;
  const received = raw.received === undefined ? undefined : String(raw.received);
  // Every field BOUNDED, not just the number of issues (ISS-897). These are
  // published raw in `session list --format json`, and all four originate in a
  // file this process could not validate: an object key can be arbitrarily
  // long, so `renderPath` can be, and zod echoes a received value into its
  // message. Capping the issue COUNT while leaving one issue unbounded caps
  // nothing. The cap reports the original length, so a reader can still tell an
  // ordinary field from a payload built to flood.
  return {
    path: boundField(renderPath(issue.path)),
    ...(expected === undefined ? {} : { expected: boundField(expected) }),
    ...(received === undefined ? {} : { received: boundField(received) }),
    message: boundField(issue.message),
  };
}

/**
 * Small enough that `sanitizeDisplayText` never re-truncates the result.
 *
 * That second truncation is what removes the magnitude: the display cap
 * appends a bare "... (truncated)" and drops the "(truncated from N)" suffix
 * this one adds, leaving a reader unable to tell how much was cut.
 */
const MAX_ISSUE_FIELD = 200;

function boundField(value: string): string {
  if (value.length <= MAX_ISSUE_FIELD) return value;
  return `${value.slice(0, MAX_ISSUE_FIELD)}... (truncated from ${value.length} characters)`;
}

/**
 * Structured view of a parse failure, bounded on BOTH axes so a wholly
 * unrelated file cannot produce an unbounded payload: the number of issues is
 * capped here, and every field of each issue is capped by `toSchemaIssue`.
 * Capping only the count capped nothing -- one issue whose object key is a
 * megabyte is a megabyte.
 *
 * The result is a bounded, normalized representation rather than the original
 * data: paths are rendered into this module's notation, non-string sides are
 * stringified, and any field over the cap carries an original-length suffix.
 * Both caps are REPORTED rather than hidden, because a silently truncated
 * diagnostic is the same defect this module exists to fix.
 */
export function summarizeZodIssues(error: ZodError, limit = 3): readonly SchemaIssue[] {
  return error.issues.slice(0, Math.max(1, limit)).map(toSchemaIssue);
}

/**
 * One line naming the field and both sides, e.g.
 * `codexUnavailableSince expected string, received null`.
 *
 * `total` is the pre-cap issue count; pass it so the suffix can say how many
 * were withheld. Omitted, the rendered issues are assumed to be all of them.
 */
export function describeSchemaIssues(issues: readonly SchemaIssue[], total = issues.length): string {
  return renderSchemaIssues(issues, total, (t) => t);
}

/**
 * The same line, for a sink that RENDERS Markdown (ISS-897).
 *
 * `describeSchemaIssues` neutralizes control characters and stops there, which
 * is right for a terminal. `handleSessionReport` interpolates this string into
 * its Markdown output and `storybloq_session_report` hands that to an MCP
 * client, so on that path a field name or a Zod message can author a link, a
 * raw element or a code span -- through the FAILURE branch, while the success
 * branch is document-safe. An injection that only works when the file is
 * broken is not a smaller problem: a broken file is exactly when an operator
 * is reading this.
 *
 * The values are attacker-shaped in a way the surrounding code is not. A Zod
 * path segment is a KEY from the untrusted JSON, so it is whatever the writer
 * put there, and `message` embeds received values.
 */
export function describeSchemaIssuesDocument(
  issues: readonly SchemaIssue[],
  total = issues.length,
): string {
  return renderSchemaIssues(issues, total, escapeMarkdownDocumentStrict);
}

function renderSchemaIssues(
  issues: readonly SchemaIssue[],
  total: number,
  escape: (text: string) => string,
): string {
  if (issues.length === 0) return "no field detail available";
  // `received`, `message`, and the path all originate in a `state.json` this
  // process did not write and could not validate, and this string is printed to
  // a terminal. What arrives here is the BOUNDED, NORMALIZED `SchemaIssue`:
  // paths are already in this module's dotted/bracket notation and non-string
  // sides are already stringified, so this step adds display sanitization and
  // nothing else. It is not the original value, and the docblock on
  // `summarizeZodIssues` says what it is.
  const parts = issues.map((issue) => {
    const field = escape(sanitizeDisplayText(issue.path.length > 0 ? issue.path : "(root)"));
    if (issue.expected !== undefined && issue.received !== undefined) {
      return `${field} expected ${escape(sanitizeDisplayText(issue.expected))}, received ${escape(sanitizeDisplayText(issue.received))}`;
    }
    return `${field}: ${escape(sanitizeDisplayText(issue.message))}`;
  });
  if (total > issues.length) parts.push(`and ${total - issues.length} more`);
  return parts.join("; ");
}
