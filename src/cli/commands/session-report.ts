/**
 * Session report handler -- structured analysis of an autonomous session.
 * Decoupled from ProjectState: reads session files directly.
 * Works even if .story/ project state is corrupted.
 */
import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { readSessionStrict, readEvents, sessionDir } from "../../autonomous/session.js";
import { describeSchemaIssuesDocument } from "../../core/zod-issues.js";
import { escapeMarkdownDocumentStrict } from "../../core/output-formatter.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import { safeJson, MAX_DISPLAY_SERIALIZED_LENGTH } from "../../core/safe-json.js";
import { gitLogRange } from "../../autonomous/git-inspector.js";
import { formatSessionReport } from "../../core/session-report-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import type { CommandResult } from "../types.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleSessionReport(
  sessionId: string,
  root: string,
  format: OutputFormat = "md",
): Promise<CommandResult> {
  // 1. Validate sessionId format (path traversal prevention)
  if (!UUID_REGEX.test(sessionId)) {
    return {
      output: `Error: Invalid session ID format "${sessionId}". Must be a UUID.`,
      exitCode: 1,
      errorCode: "invalid_input",
      isError: true,
    };
  }

  // 2. NO directory-existence precheck (ISS-897).
  //
  // It was a separate filesystem SNAPSHOT ahead of the reader, so a directory
  // created between the two made this command answer `not_found` for a session
  // `session show` and `session list` could read -- the same cross-surface race
  // that removing the schema precheck below closed. `readSessionStrict` already
  // returns `missing`, which maps to `not_found` here, so the check added no
  // classification and one more chance to disagree.
  const dir = sessionDir(root, sessionId);

  // 3. NO separate schema-version precheck (ISS-897).
  //
  // `readSessionStrict` implements the same version fence -- `version-skew` for
  // a newer numeric version, `unsupported-version` for every other present
  // value it cannot support -- so a second read here was a second SNAPSHOT: if `state.json`
  // is replaced atomically between the two, this command classified the old
  // file revision while `session show` and `session list` classified the new ones --
  // reintroducing, through a race, exactly the cross-surface disagreement this
  // work exists to remove. One read, one implementation, one answer.

  // 4. Full session parse
  const parseResult = readSessionStrict(dir);
  if (!parseResult.ok) {
    // ISS-897 / N-097 operator 4: this is the command every other error message
    // sends operators to, so a single constant here left them with nowhere
    // further to go. Report WHICH failure, over every shape of the union --
    // including the two `readSessionStrict` cannot currently return, so a future
    // widening cannot silently fall through to the wrong sentence.
    //
    // The FRAMING varies too, not just the detail. "invalid state.json" for a
    // directory that holds no state.json sends someone looking for a file to
    // repair that is not there, and "corrupt" for a version skew is worse still:
    // that session was never interpreted rather than found wrong (ISS-902), so a
    // reader told "corrupt" goes hunting for damage instead of upgrading.
    const { failure } = parseResult;
    const { framing, problem } =
      failure.kind === "missing"
        ? {
            // Now the ONLY not-found path, since the directory precheck is gone.
            // `missing` means `probePath` proved absence, which covers both a
            // session that never existed and one deleted mid-command; the
            // wording has to serve both without asserting which.
            framing: "not found",
            problem: "no session directory exists at that path -- it was never created, or it has been removed",
          }
        : failure.kind === "version-skew"
          ? {
              framing: "could not be read",
              problem:
                `it was written by a newer storybloq (session schema v${failure.writerVersion}; this build reads v${failure.readerVersion}). ` +
                "This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound. Restart your AI client to reload the MCP server, or upgrade storybloq " +
                "(npm install -g @storybloq/storybloq@latest), then retry. Do NOT delete it",
            }
          : // FRAMED BY REASON, not by the `unreadable` kind. Only `schema` and
            // `invalid-json` READ the bytes and found them wrong; `missing-state`
            // covers a session mid-creation or a dangling directory link, and
            // `unreadable-file` covers EACCES, EIO and an inconclusive probe.
            // Calling those "corrupt" -- and returning `project_corrupt` to an
            // automated caller -- asserts damaged data over evidence that
            // establishes none, right beside a problem line that says otherwise.
            failure.reason === "unsupported-version"
            ? {
                // Framed like the newer-writer branch, not like corruption: the
                // file may be entirely well-formed under a version this build
                // does not know. The scanner admits the same record and warns
                // against deleting it, and two operator surfaces must not
                // disagree about one file -- that disagreement was destructive
                // in exactly one direction.
                framing: "could not be read",
                problem:
                  // The VALUE, not just the fact. This branch covers a lower
                  // number, a string, null and an object, and without the value
                  // an operator cannot work out which reader would understand
                  // it -- which is also why the remedy is "a storybloq that
                  // supports that schema" rather than "upgrade": upgrading is
                  // the fix for a NEWER writer and does nothing for an older or
                  // malformed one.
                  // Document-escaped, not merely sanitized: this string is
                  // interpolated into Markdown that `storybloq_session_report`
                  // returns to an MCP client, and `rawVersion` is a value from
                  // the untrusted file -- a string, so it can be a link or a
                  // raw element as easily as a number.
                  `its \`schemaVersion\` is ${escapeMarkdownDocumentStrict(sanitizeDisplayText(safeJson(failure.rawVersion, MAX_DISPLAY_SERIALIZED_LENGTH)))}, which is not one this build supports. ` +
                  "This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound. " +
                  "Inspect state.json directly, or use a storybloq version that supports that schema, " +
                  "then retry. Do NOT delete it",
              }
            : failure.reason === "schema"
            ? {
                framing: "corrupt",
                problem: `invalid state.json: ${describeSchemaIssuesDocument(failure.issues ?? [], failure.issueCount)}`,
              }
            : failure.reason === "invalid-json"
              ? { framing: "corrupt", problem: "state.json is not valid JSON" }
              : failure.reason === "missing-state"
                ? {
                    framing: "incomplete or unavailable",
                    problem: "an entry exists at that path, but no readable state.json is in it",
                  }
                : { framing: "could not be read", problem: "state.json could not be read" };
    // The CODE has to agree with the framing, or an automated caller reads an
    // UNINTERPRETED newer-version session, or one that vanished mid-race, as
    // project corruption while the human-readable line says otherwise.
    const corruptionEstablished =
      failure.kind === "unreadable" && (failure.reason === "schema" || failure.reason === "invalid-json");
    return {
      output: `Error: Session ${sessionId} ${framing} -- ${problem}.`,
      exitCode: 1,
      errorCode:
        failure.kind === "missing"
          ? "not_found"
          : failure.kind === "version-skew" ||
              (failure.kind === "unreadable" && failure.reason === "unsupported-version")
            ? "version_mismatch"
            : corruptionEstablished
              ? "project_corrupt"
              : // `io_error`, not a new code: the two remaining reasons ARE read
                // failures, and this is the existing code for that. Minting a
                // new one would change the MCP classification surface to say
                // something `io_error` already says accurately.
                "io_error",
      isError: true,
    };
  }
  const state = parseResult.state;

  // 5. Read events.log (tolerant)
  const events = readEvents(dir);

  // 6. Read plan.md (optional)
  let planContent: string | null = null;
  const planResult = tryReadFile(join(dir, "plan.md"));
  if (planResult.ok) planContent = planResult.content;

  // 7. Git log for session range (best-effort -- requires both refs)
  let gitLog: string[] | null = null;
  const initHead = state.git.initHead ?? null;
  const lastCommit = state.completedTickets.length > 0
    ? state.completedTickets[state.completedTickets.length - 1]!.commitHash ?? null
    : state.git.expectedHead ?? null;
  if (initHead && lastCommit) {
    const result = await gitLogRange(root, initHead, lastCommit, 20);
    if (result.ok) {
      gitLog = result.data;
    }
  }

  // 8. Format report
  const output = formatSessionReport({ state, events, planContent, gitLog }, format);
  return { output };
}
