import { displayIdOf } from "../../core/resolver.js";
/**
 * T-251: `storybloq session` CLI -- list, show, repair, delete.
 *
 * Four admin subcommands for inspecting and repairing session state. Every
 * user-supplied selector flows through resolveSessionSelector for path
 * containment. Every bulk enumerator is already hardened in session.ts and
 * core/session-scan.ts.
 *
 * repair is the manual escape hatch for T-250 auto-supersede. It supersedes
 *   - `finished_orphan` bucket always (same predicate as T-250)
 *   - `stale_other` bucket only with --all (and interactive confirmation)
 * and never mutates a session whose revision/status drifted between scan and
 * write (under-lock re-validation).
 */
import { existsSync } from "node:fs";
import { tryReadFile } from "../util/file-io.js";
import { basename, join } from "node:path";
import {
  findStaleSessions,
  findResumableSession,
  isLeaseExpired,
  listAllSessionsDetailed,
  readSession,
  readSessionStrict,
  writeSessionWithEvent,
  withSessionLock,
  deleteSessionDir,
  type ActiveSessionInfo,
  type SessionLookupFailure,
} from "../../autonomous/session.js";
import {
  resolveSessionSelector,
  describeIncompatible,
  incompatibleVersionDetail,
  SESSION_ID_REGEX,
  isContainedSessionDir,
  type IncompatibleCause,
} from "../../autonomous/session-selector.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../autonomous/session-types.js";
import {
  computeSessionDirAge,
  AGED_ANOMALY_WINDOW_MS,
  describeAddressableAgedAnomaly,
  describeUnaddressableAgedAnomaly,
} from "../../core/session-age.js";
import { isFinishedOrphan } from "../../autonomous/orphan-detector.js";
import type { FullSessionState } from "../../autonomous/session-types.js";
import { describeSchemaIssues } from "../../core/zod-issues.js";
import { rawVersionField } from "../../core/safe-json.js";
import { boundedLines } from "../../core/bounded-list.js";
import { deriveLeaseState } from "../../core/session-scan.js";
import { lstatSync } from "node:fs";
import { sanitizeDisplayText, sanitizeDisplayPath } from "../../core/display-text.js";

// ---------------------------------------------------------------------------
// Testing hook: revision-drift injection (test 12)
// ---------------------------------------------------------------------------

interface InjectedState {
  scannedRevisionFor: Record<string, number> | null;
}

let injectedState: InjectedState = { scannedRevisionFor: null };

/**
 * Testing-only hook. Forces a stale scannedRevision for specified session IDs
 * so tests can prove the under-lock drift check skips mismatched entries.
 * Pass `{ scannedRevisionFor: null }` to clear.
 */
export function __t251RepairInject(state: InjectedState): void {
  injectedState = state;
}

// ---------------------------------------------------------------------------
// session list
// ---------------------------------------------------------------------------

export interface ListOpts {
  status: "active" | "completed" | "superseded" | "all";
  format: "text" | "json";
}

/**
 * Human-readable cause for a session whose state.json will not load (ISS-897).
 *
 * Falls back to the old constant only when the caller has no failure detail,
 * which is the pre-ISS-897 shape rather than a case that should still happen.
 */
export function describeCorruption(failure?: SessionLookupFailure): string {
  if (!failure) return "corrupt or unreadable";
  switch (failure.kind) {
    case "missing":
      return "missing";
    case "version-skew":
      // Unreachable through `session list` and `session show`, which now route
      // version skew to their own collections and branches before reaching here
      // (ISS-897). Kept, and kept non-damaging, because this function takes the
      // whole union and a future caller must not get "corrupt" by default.
      return (
        `written by a newer storybloq and not interpreted here (session schema v${failure.writerVersion}; ` +
        `this build reads v${failure.readerVersion}) -- restart your AI client or upgrade storybloq; do NOT delete it`
      );
    case "unreadable":
      switch (failure.reason) {
        case "schema":
          return `invalid: ${describeSchemaIssues(failure.issues ?? [], failure.issueCount)}`;
        case "invalid-json":
          return "not valid JSON";
        case "missing-state":
          // "the entry is there", NOT "the directory exists". Both a real
          // directory without a state file and a DANGLING directory symlink
          // reach this reason: `readSessionStrict` only established that the
          // path is not absent, which is what separates this from `missing`.
          // Claiming the directory exists sends an operator who has a broken
          // link to go create a state.json inside it, and the write follows the
          // link somewhere else.
          return "missing (an entry exists at that path, but no readable state.json is in it)";
        case "unreadable-file":
          // NOT "present but unreadable". This reason also covers EACCES,
          // ENOTDIR, EIO, and a directory probe that could not answer -- none of
          // which established that a state.json entry is there.
          return "could not be read";
        case "unsupported-version":
          // Phrased like the version-skew branch rather than the corruption
          // branches -- but NOT claiming the file is intact. The version fence
          // runs BEFORE the fields are validated, so this build has not looked
          // at them: a truncated file with `schemaVersion: 0` lands here too.
          // What is established is only that this build did not interpret it,
          // which is enough to forbid deleting it and not enough to vouch for it.
          return "carrying a `schemaVersion` this build does not support -- it was not interpreted, so nothing here shows it is damaged OR sound; inspect state.json or use a storybloq that supports that schema; do NOT delete it";
      }
  }
}

export async function handleSessionList(root: string, opts: ListOpts): Promise<string> {
  // ISS-897: `listAllSessions` drops what it cannot parse, which made THIS
  // command -- the one the ownership guard tells operators to run when it
  // cannot determine state -- silently omit the damaged session they came to
  // find. Damaged rows are never filtered by `--status`: they have no status to
  // filter on, and hiding them is the concealment being fixed.
  const { sessions: all, damaged, unavailable, incompatible } = listAllSessionsDetailed(root);
  const filtered = opts.status === "all"
    ? all
    : all.filter((s) => s.state.status === opts.status);

  filtered.sort((a, b) => {
    const at = a.state.lastGuideCall ? new Date(a.state.lastGuideCall).getTime() : 0;
    const bt = b.state.lastGuideCall ? new Date(b.state.lastGuideCall).getTime() : 0;
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
    if (bt !== at) return bt - at;
    return a.state.sessionId.localeCompare(b.state.sessionId);
  });

  if (opts.format === "json") {
    return JSON.stringify(
      {
        sessions: filtered.map((s) => ({
          sessionId: s.state.sessionId,
          status: s.state.status,
          state: s.state.state,
          leaseExpiresAt: s.state.lease?.expiresAt ?? null,
          // The guard's decision matrix turns on leaseState, and population
          // membership additionally needs compactPending (ISS-911). Derived by
          // the SAME function the scanner uses, so this surface and the guard
          // cannot drift.
          leaseState: deriveLeaseState(s.state.lease?.expiresAt),
          compactPending: s.state.compactPending ?? false,
          ticketId: (s.state as FullSessionState & { ticket?: { id?: string } }).ticket?.id ?? null,
          mode: s.state.mode ?? "auto",
          lastGuideCall: s.state.lastGuideCall ?? null,
          sourceDir: basename(s.dir),
        })),
        damaged: damaged.map((d) => ({
          sourceDir: d.sourceDir,
          reason: describeCorruption(d.failure),
          issues: d.failure.kind === "unreadable" ? (d.failure.issues ?? []) : [],
        })),
        // Its OWN key, and `damaged` above is now narrowed to the two reasons
        // that actually READ the bytes (ISS-897). A consumer that cleans up
        // whatever `damaged` contains would otherwise delete a session over a
        // permission error or a creation race; the name of each collection is
        // part of the contract, not a label on the same pile.
        unavailable: unavailable.map((d) => ({
          sourceDir: d.sourceDir,
          reason: describeCorruption(d.failure),
        })),
        incompatible: incompatible.map((i) => ({
          sourceDir: i.sourceDir,
          cause: i.cause,
          // NOT `{ rawVersion: i.rawVersion }`. That put an arbitrary value out
          // of a `state.json` into the object this function is about to
          // `JSON.stringify`, so a file nested deeper than the encoder can go
          // -- which PARSES without complaint -- threw a RangeError and took
          // the whole listing with it. `rawVersionField` publishes the value
          // when it is encodable and small, and a bounded serialization under
          // a different key when it is not, so a consumer can tell which it
          // got.
          ...(i.cause === "newer" ? { writerVersion: i.writerVersion } : rawVersionField(i.rawVersion)),
          readerVersion: i.readerVersion,
          reason: describeIncompatible(i),
        })),
      },
      null,
      2,
    );
  }

  if (
    filtered.length === 0 &&
    damaged.length === 0 &&
    unavailable.length === 0 &&
    incompatible.length === 0
  ) {
    return "No sessions found.";
  }

  const lines: string[] = [];
  // LeaseState is the guard's vocabulary (live/expired/missing/invalid),
  // printed rather than left to inference from the relative expiry: a lease
  // "in 34m" on a session whose owner is dead READS healthy, and the operator
  // in N-097 misread exactly that. Compact says whether a COMPACT session is
  // actually resume-pending, the second input population membership needs.
  lines.push("Session ID                            Status      State        Lease              LeaseState  Compact  Ticket   Mode");
  lines.push("------------------------------------  ----------  -----------  -----------------  ----------  -------  -------  ------");
  // BLOCKS, not lines. A damaged entry is a row plus a detail, a remedy and an
  // address, and a bound that cut between them would leave a fault named with
  // no way to reach it. Each collection is bounded separately so one large
  // population cannot squeeze another out of the output entirely.
  const readableBlocks: string[][] = [];
  const incompatibleBlocks: string[][] = [];
  const unavailableBlocks: string[][] = [];
  const damagedBlocks: string[][] = [];
  for (const s of filtered) {
    const ticketId =
      (s.state as FullSessionState & { ticket?: { id?: string } }).ticket?.id ?? "-";
    // SANITIZED, even though this row PARSED (ISS-897). Passing the schema is
    // not the same as being safe to print: `state` is deliberately a free
    // string (T-328) so a newer workflow state does not brick an older reader,
    // `mode` and the ticket id are equally unconstrained, and every one of them
    // is read straight out of `state.json`. An ESC or a newline in any of them
    // forges a row in the exact table an operator consults during an incident
    // to decide whether another agent is running. The JSON branch keeps the raw
    // bytes, because a consumer diffing against the file needs what is there.
    readableBlocks.push([
      [
        sanitizeDisplayText(s.state.sessionId).padEnd(36),
        sanitizeDisplayText(s.state.status).padEnd(10),
        sanitizeDisplayText(s.state.state).padEnd(11),
        sanitizeDisplayText(formatLease(s.state.lease?.expiresAt)).padEnd(17),
        deriveLeaseState(s.state.lease?.expiresAt).padEnd(10),
        ((s.state.compactPending ?? false) ? "pending" : "-").padEnd(7),
        sanitizeDisplayText(ticketId).padEnd(7),
        sanitizeDisplayText(s.state.mode ?? "auto").padEnd(6),
      ].join("  "),
    ]);
  }
  for (const i of incompatible) {
    const safeDir = sanitizeDisplayText(i.sourceDir);
    incompatibleBlocks.push([
      [
        safeDir.padEnd(36),
        // The status names the CAUSE, not a remedy the cause does not
        // establish. `needs-upgrade` is right for a newer writer and wrong for
        // everything else: a lower, string, null or object `schemaVersion` may
        // want an OLDER build, or may be a file nobody's build wrote.
        (i.cause === "newer" ? "needs-upgrade" : "unsupported").padEnd(10),
        "-".padEnd(11),
        "-".padEnd(17),
        "-".padEnd(10),
        "-".padEnd(7),
        "-".padEnd(7),
        "-".padEnd(6),
      ].join("  "),
      `    ${describeIncompatible(i)}`,
    ]);
    // The same address line the damaged and unavailable rows get, and it was
    // missing only here. This enumerator admits a contained directory under ANY
    // name, so an incompatible session in a legacy or hand-created directory
    // had no way to be reached: the CLI selector will not resolve a
    // non-canonical name, and the only identifier printed was the
    // `sanitizeDisplayText` label, which maps every dangerous code point to `?`
    // -- so two distinct directories can render as one row's worth of name.
    // The row said "inspect state.json" and gave no unambiguous path to it.
    incompatibleBlocks[incompatibleBlocks.length - 1]!.push(addressLine(i.sourceDir, i.dir, safeDir));
  }
  // Rendered like the damaged rows below but under their own status, because
  // nothing here established damage: `missing-state` is a creation race or a
  // dangling link, `unreadable-file` is a permission or I/O failure.
  for (const d of unavailable) {
    const safeDir = sanitizeDisplayText(d.sourceDir);
    unavailableBlocks.push([
      [
        safeDir.padEnd(36),
        "unavailable".padEnd(10),
        "-".padEnd(11),
        "-".padEnd(17),
        "-".padEnd(10),
        "-".padEnd(7),
        "-".padEnd(7),
        "-".padEnd(6),
      ].join("  "),
      `    state.json ${describeCorruption(d.failure)}`,
      `    ${corruptRemedy(root, safeDir, d.dir, d.failure.kind === "unreadable" ? d.failure.reason : undefined)}`,
      addressLine(d.sourceDir, d.dir, safeDir),
    ]);
  }
  for (const d of damaged) {
    // Keyed by directory, not by session id: the id lives inside the file that
    // would not load, so it is exactly what is unavailable here. The name is
    // untrusted filesystem input, so control characters are stripped before it
    // reaches a terminal.
    const safeDir = sanitizeDisplayText(d.sourceDir);
    damagedBlocks.push([
      [
        safeDir.padEnd(36),
        "corrupt".padEnd(10),
        "-".padEnd(11),
        "-".padEnd(17),
        "-".padEnd(10),
        "-".padEnd(7),
        "-".padEnd(7),
        "-".padEnd(6),
      ].join("  "),
      `    state.json ${describeCorruption(d.failure)}`,
      // Only advertise the selector when it will actually resolve. This
      // enumerator accepts a contained directory of ANY name, while
      // `resolveSessionSelector` requires a canonical session UUID -- so
      // printing the command unconditionally hands the operator of a legacy or
      // hand-created directory an instruction that fails. `dir` always works as
      // an address even when the CLI cannot take it as a selector.
      addressLine(d.sourceDir, d.dir, safeDir),
    ]);
  }
  for (const [blocks, noun] of [
    [readableBlocks, "sessions"],
    [incompatibleBlocks, "incompatible sessions"],
    [unavailableBlocks, "unavailable sessions"],
    [damagedBlocks, "damaged sessions"],
  ] as const) {
    lines.push(...boundedBlocks(blocks, noun));
  }
  return lines.join("\n");
}

/** How many entries per collection the TEXT listing renders in full (ISS-897). */
const MAX_LISTED_PER_COLLECTION = 50;

/** The same, for the per-session detail view's arrays (ISS-897). */
const MAX_SHOWN_PER_COLLECTION = 50;

/**
 * Bound a collection without ever splitting an entry from its remedy.
 *
 * The number of session directories is workspace-controlled, and each damaged
 * entry is four lines, so the text listing could be made arbitrarily long. What
 * a cut must not do is print a fault and drop the address for reaching it, so
 * the unit is the BLOCK. `--format json` stays complete, and the suffix says
 * so: a shortened listing that does not announce itself reads as an inventory.
 */
function boundedBlocks(blocks: readonly (readonly string[])[], noun: string): string[] {
  if (blocks.length <= MAX_LISTED_PER_COLLECTION) return blocks.flatMap((b) => [...b]);
  return [
    ...blocks.slice(0, MAX_LISTED_PER_COLLECTION).flatMap((b) => [...b]),
    `    ... showing ${MAX_LISTED_PER_COLLECTION} of ${blocks.length} ${noun}; use \`--format json\` for the complete set`,
  ];
}

/**
 * How to NAME the failure, by what the evidence supports (ISS-897).
 *
 * `res.corrupt` spans four reasons and only two of them read the bytes. Opening
 * every one of them with "state.json is corrupt" asserted damaged data for a
 * session mid-creation and for an EACCES, and then contradicted itself in the
 * reason-specific remedy printed immediately after.
 */
function corruptFraming(reason: CorruptReason | undefined): string {
  switch (reason) {
    case "schema":
    case "invalid-json":
      return "is corrupt";
    case "missing-state":
      return "is incomplete or unavailable";
    case "unreadable-file":
      return "could not be read";
    case "unsupported-version":
      // Unreachable through `corrupt` now that the type excludes it, kept so
      // this stays total against `CorruptReason` rather than falling into the
      // undetermined phrasing below and reading as though it were a mystery.
      return "was not interpreted by this build";
    case undefined:
      return "could not be loaded";
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled corrupt reason: ${String(exhaustive)}`);
    }
  }
}

/**
 * How to reach this row, advertising the CLI selector ONLY when it resolves.
 *
 * Two conditions, and the second one is not decoration. `resolveSessionSelector`
 * needs a canonical session id AND a contained DIRECTORY, so the name test alone
 * is a claim about half of what it checks. That was harmless while every row
 * came from a directory; it stopped being harmless when `unavailable` grew the
 * shapes the scanner diagnoses -- a symlink of any name, and a session-SHAPED
 * name on something that is not a directory. The second of those passes the
 * regex and fails the command, which prints "invalid" or "not found" over an
 * entry the operator was just told exists. That is the dead end this issue
 * closes, arriving as a wrong instruction rather than as silence.
 *
 * Shared by the damaged, unavailable and incompatible loops. It was inlined in
 * the first of them, so splitting the collection dropped the by-hand address
 * for every `missing-state` and `unreadable-file` row -- and those are exactly
 * the rows most likely to sit under a legacy or hand-created directory name.
 * The incompatible loop was the last to get it.
 *
 * `dir` is always a usable address, so the fallback loses nothing.
 */
function addressLine(sourceDir: string, dir: string, safeDir: string): string {
  if (SESSION_ID_REGEX.test(sourceDir) && isRealDirectory(dir)) {
    return `    inspect: storybloq session show ${safeDir}`;
  }
  const why = SESSION_ID_REGEX.test(sourceDir)
    ? "this entry is not a directory, so the CLI selector cannot address it"
    : "the directory name is not a session id, so the CLI selector cannot address it";
  return `    inspect by hand: ${sanitizeDisplayPath(dir)}  (${why})`;
}

/**
 * A directory, not following symlinks.
 *
 * `statSync` would follow, so a link POINTING at a directory would answer yes
 * -- and `resolveSessionSelector` refuses to read through a link out of the
 * sessions root (T-251), so it would still fail. The probe has to ask the same
 * question the resolver asks.
 */
function isRealDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function formatLease(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "-";
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return "-";
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return diffMs >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

// ---------------------------------------------------------------------------
// session show
// ---------------------------------------------------------------------------

export interface ShowOpts {
  format: "text" | "json";
  events: number;
}

/** Every way `readSessionStrict` can report an unreadable session. */
type CorruptReason = "missing-state" | "unreadable-file" | "invalid-json" | "schema" | "unsupported-version";

/**
 * The remedy for a corrupt session, chosen EXHAUSTIVELY by reason (ISS-897).
 *
 * Only `schema` and `invalid-json` establish bad DATA, and only those two earn
 * advice that destroys it; every other reason requires a non-destructive
 * remedy. Counting them here was brittle -- `unsupported-version` was added and
 * the count was not:
 *
 *  - `schema` / `invalid-json`  the bytes were read and are wrong. Deleting or
 *    hand-editing is the fix.
 *  - `unreadable-file`  EACCES, EIO, ENOTDIR, or an ENOENT whose probe could not
 *    answer. The file may be perfectly intact behind a permission bit or a
 *    failing disk, so "delete it" destroys a live session over a transient
 *    fault -- at incident time, when the operator is most likely to comply.
 *  - `missing-state`  covers a session mid-creation and a dangling directory
 *    symlink: deleting during the creation window races the writer, and "edit
 *    state.json by hand" through a broken link writes somewhere else. AGED
 *    past `AGED_ANOMALY_WINDOW_MS` (ISS-945), that advice is wrong for the
 *    opposite reason -- it steers away from a command that is actually safe to
 *    name -- so this branch alone re-checks age via the SAME shared helper
 *    `scanSessionSummaries` uses, so the CLI and the MCP diagnostic cannot
 *    describe the same directory two different ways.
 *
 * Shared by every command that reports a corrupt session, so one of them cannot
 * keep the destructive default after the others have dropped it. Takes `root`
 * and `dir` (not just `sessionId`) purely for the `missing-state` age
 * re-check -- neither `listAllSessionsDetailed` nor `resolveSessionSelector`
 * hands this function a pre-computed age, so it computes its own rather than
 * assuming data that is not there.
 */
function corruptRemedy(root: string, sessionId: string, dir: string, reason: CorruptReason | undefined): string {
  switch (reason) {
    case "schema":
    case "invalid-json":
      // The only two that READ the bytes and found them wrong.
      return `Use 'storybloq session delete ${sessionId} --yes' to remove it, or edit state.json by hand.`;
    case "missing-state": {
      const age = computeSessionDirAge(dir, Date.now());
      if (age.kind !== "known" || age.ageMs < AGED_ANOMALY_WINDOW_MS) {
        return "Inspect the path directly. If a session is being created it will finish on its own -- retry in a moment. Do not delete it and do not write a state.json through it until you have confirmed what is at that path.";
      }
      // `sessionId` here can be a legacy or hand-created non-canonical
      // directory name (any name is admitted -- see RESERVED_SESSION_DIR_NAMES's
      // doc in session-scan.ts), and `resolveSessionSelector` can never resolve
      // one, so `session delete` cannot address it either.
      const addressable = SESSION_ID_REGEX.test(sessionId) && isContainedSessionDir(root, dir);
      return addressable ? describeAddressableAgedAnomaly(sessionId) : describeUnaddressableAgedAnomaly();
    }
    case "unreadable-file":
      return "The read itself failed, so the file may be intact. Check permissions and the underlying disk, then retry. Do not delete it until you have read it and confirmed the contents are bad.";
    case "unsupported-version":
      // Not damage -- and not vouched for either. The fence returns before the
      // schema runs, so this build has read nothing but the version field.
      return "This build did not interpret the file, so nothing establishes that it is damaged OR that it is sound. Inspect state.json directly, or use a storybloq that supports that schema, then retry. Do NOT delete it.";
    case undefined:
      // `corruptFailure` is optional for compatibility, so this is a SUPPORTED
      // input -- and it carries no evidence at all. Falling through to the
      // destructive default meant the least informed case got the most
      // irreversible advice.
      return "This build could not determine why. Read state.json before doing anything to it; do not delete it on this evidence.";
    default: {
      // A new reason must not silently inherit deletion advice: this fails to
      // compile the moment one is added without a remedy here.
      const exhaustive: never = reason;
      throw new Error(`unhandled corrupt reason: ${String(exhaustive)}`);
    }
  }
}

export async function handleSessionShow(
  root: string,
  selector: string,
  opts: ShowOpts,
): Promise<string> {
  const res = resolveSessionSelector(root, selector);
  if (res.kind === "invalid") throw new Error(res.reason);
  if (res.kind === "not_found") throw new Error(`Session ${selector} not found`);
  if (res.kind === "ambiguous") {
    throw new Error(
      `Session selector "${selector}" matches ${res.matches.length} sessions: ${res.matches.join(
        ", ",
      )}. Use a longer prefix.`,
    );
  }
  // A version skew is NOT corruption and must not reach the branch below, whose
  // remedy is deletion (ISS-897/ISS-902). Nothing read that session's fields:
  // this build could not interpret the schema the file claims, which does not
  // establish that anything is wrong with it. Only the `newer` cause means this
  // reader is too old -- the same `kind` also carries a lower, string, null or
  // object version, where upgrading may be no help at all. It is its own `kind`
  // rather than a flag on `resolved` so that the compiler asks every caller this
  // question instead of letting one fall through to the destructive answer.
  if (res.kind === "incompatible") {
    throw new Error(
      `Session ${res.sessionId} is ${describeIncompatible(res)}.`,
    );
  }
  if (res.corrupt) {
    // ISS-897 / N-097 operator 4: name the field. "corrupt or unreadable" sent
    // an operator to extract the zod schema by hand to find a one-line fix.
    //
    // The REMEDY is chosen EXHAUSTIVELY by reason, not appended to all of them.
    // Only `schema` and `invalid-json` establish bad DATA, and only those two earn advice
    // that destroys it:
    //
    //  - `schema` / `invalid-json`  the bytes were read and are wrong. Deleting
    //    or hand-editing is the fix.
    //  - `unreadable-file`  EACCES, EIO, ENOTDIR, or an ENOENT whose probe could
    //    not answer. The file may be perfectly intact behind a permission bit or
    //    a failing disk, so "delete it" destroys a live session over a transient
    //    fault -- at incident time, when the operator is most likely to comply.
    //  - `missing-state`  covers a session mid-creation and a dangling directory
    //    symlink: deleting during the creation window races the writer, and
    //    "edit state.json by hand" through a broken link writes somewhere else.
    const remedy = corruptRemedy(root, res.sessionId, res.dir, res.corruptFailure?.reason);
    // `describeCorruption` returns a VERB PHRASE for the reasons that never read
    // the bytes ("could not be read"), so prefixing "is" produced "state.json is
    // could not be read" -- reachable on the `unreadable-file` path this change
    // added, in the error an operator sees at incident time.
    throw new Error(
      `Session ${res.sessionId} state.json ${describeCorruption(res.corruptFailure)}. ${remedy}`,
    );
  }

  const state = res.state!;
  const events = readTailEvents(res.dir, opts.events);

  if (opts.format === "json") {
    return JSON.stringify({ state, recentEvents: events }, null, 2);
  }

  // SANITIZED for the same reason the list table is, and it matters more here:
  // `session show` is where an operator goes after the table tells them
  // something is wrong, and every value below is read straight out of a
  // `state.json` this build did not write. `state` is a free string by design
  // (T-328), the ticket id and title are unconstrained, and the event fields
  // come off an append-only log. A newline in any of them forges one of these
  // labelled lines; an ESC redraws it. The JSON branch above keeps the raw
  // bytes, because a consumer diffing against the file needs what is there.
  const show = (v: unknown): string => sanitizeDisplayText(String(v));
  const lines: string[] = [];
  lines.push(`Session: ${show(state.sessionId)}`);
  lines.push(`Status:  ${show(state.status)}`);
  lines.push(`State:   ${show(state.state)}`);
  lines.push(`Mode:    ${show(state.mode ?? "auto")}`);
  lines.push(`Recipe:  ${show(state.recipe)}`);
  lines.push(
    `Lease:   ${show(formatLease(state.lease?.expiresAt))} (${show(state.lease?.expiresAt ?? "n/a")})`,
  );
  const ticket = (state as FullSessionState & { ticket?: { id?: string; displayId?: string; title?: string } }).ticket;
  if (ticket?.id) {
    lines.push(`Ticket:  ${show(displayIdOf(ticket))} -- ${show(ticket.title ?? "")}`);
  }
  // BOUNDED, like every other collection rendered from a `state.json`. The
  // schema puts no ceiling on these arrays, so a valid file can make this
  // command's terminal output arbitrarily long; `--format json` stays complete.
  if (state.completedTickets.length) {
    lines.push("");
    lines.push("Completed tickets:");
    lines.push(
      ...boundedLines(
        state.completedTickets.map(
          (t) => `  ${show(displayIdOf(t))} (${show(t.commitHash?.slice(0, 8) ?? "no-hash")})`,
        ),
        {
          maxLines: MAX_SHOWN_PER_COLLECTION,
          noun: "completed tickets",
          fullSetHint: "Use `--format json` for the complete list.",
        },
      ),
    );
  }
  if ((state.resolvedIssues ?? []).length) {
    lines.push("");
    lines.push("Resolved issues:");
    lines.push(
      ...boundedLines(
        (state.resolvedIssues ?? []).map((id) => `  ${show(state.resolvedIssueDisplayIds?.[id] ?? id)}`),
        {
          maxLines: MAX_SHOWN_PER_COLLECTION,
          noun: "resolved issues",
          fullSetHint: "Use `--format json` for the complete list.",
        },
      ),
    );
  }
  if (events.length) {
    lines.push("");
    // The COUNT reported is what was read, and the list below it may be
    // shorter: `--events` is caller-chosen and nothing caps it, so an operator
    // asking for a hundred thousand gets a hundred thousand lines otherwise.
    lines.push(`Recent events (last ${events.length}):`);
    lines.push(
      ...boundedLines(
        events.map((ev) => `  [rev ${show(ev.rev)}] ${show(ev.type)} ${show(ev.timestamp)}`),
        {
          maxLines: MAX_SHOWN_PER_COLLECTION,
          noun: "events",
          fullSetHint: "Use `--format json` for the complete tail.",
        },
      ),
    );
  }
  return lines.join("\n");
}

interface TailEvent {
  rev: number;
  type: string;
  timestamp: string;
}

function readTailEvents(dir: string, limit: number): TailEvent[] {
  const eventsResult = tryReadFile(join(dir, "events.log"));
  if (!eventsResult.ok) return [];
  const raw = eventsResult.content;
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit);
  const parsed: TailEvent[] = [];
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as TailEvent;
      if (typeof e.rev === "number" && typeof e.type === "string") {
        parsed.push(e);
      }
    } catch {
      // skip malformed
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// session repair
// ---------------------------------------------------------------------------

export interface RepairOpts {
  selector?: string;
  dryRun: boolean;
  all: boolean;
  yes: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

type RepairBucket = "finished_orphan" | "stale_other";

interface RepairCandidate {
  sessionId: string;
  dir: string;
  state: FullSessionState;
  scannedRevision: number;
  bucket: RepairBucket;
  action: "supersede" | "skip";
  skipReason?: string;
}

export async function handleSessionRepair(
  root: string,
  opts: RepairOpts,
): Promise<string> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // --- Candidate collection (no lock) ---
  const raw: ActiveSessionInfo[] = [];

  if (opts.selector) {
    const res = resolveSessionSelector(root, opts.selector);
    if (res.kind === "invalid") throw new Error(res.reason);
    if (res.kind === "not_found") throw new Error(`Session ${opts.selector} not found`);
    if (res.kind === "ambiguous") {
      throw new Error(
        `Session selector "${opts.selector}" matches ${res.matches.length} sessions: ${res.matches.join(
          ", ",
        )}. Use a longer prefix.`,
      );
    }
    // Same carve-out as `session show` (ISS-897/ISS-902), and it matters more
    // here: this command's corrupt branch sends operators to `session delete`,
    // the one irreversible remedy in the set.
    if (res.kind === "incompatible") {
      throw new Error(
        `Session ${res.sessionId} is ${describeIncompatible(res)}. Repair is refused because this build could not ` +
          "determine the file's schema, and so could not determine its condition: that authorizes neither repairing nor deleting it.",
      );
    }
    if (res.corrupt) {
      // The SAME exhaustive branch `session show` takes, and it matters more
      // here: this command's only onward suggestion was `session delete`, the
      // one irreversible remedy in the set, offered for every reason including
      // the two that establish no bad data at all.
      throw new Error(
        `Session ${res.sessionId} state.json ${corruptFraming(res.corruptFailure?.reason)}; ` +
          "'session repair' can only operate on parseable sessions. " +
          corruptRemedy(root, res.sessionId, res.dir, res.corruptFailure?.reason),
      );
    }
    if (res.state!.status !== "active") {
      throw new Error(
        `Session ${res.sessionId} is ${res.state!.status}, not active. 'repair' only supersedes active orphan sessions; 'delete' is the destructive escape hatch for terminal records.`,
      );
    }
    raw.push({ state: res.state!, dir: res.dir });
  } else {
    const stale = findStaleSessions(root);
    const resumable = findResumableSession(root);
    const seen = new Set<string>();
    for (const s of stale) {
      if (s.state.status !== "active") continue;
      if (seen.has(s.state.sessionId)) continue;
      seen.add(s.state.sessionId);
      raw.push(s);
    }
    if (resumable) {
      const r = resumable.info;
      if (r.state.status === "active" && !seen.has(r.state.sessionId)) {
        seen.add(r.state.sessionId);
        raw.push(r);
      }
    }
  }

  // --- Classification ---
  const classified: RepairCandidate[] = [];
  for (const info of raw) {
    const isOrphan = await isFinishedOrphan(info.state, info.dir, root);
    const bucket: RepairBucket = isOrphan ? "finished_orphan" : "stale_other";
    const injection = injectedState.scannedRevisionFor?.[info.state.sessionId];
    const scannedRevision = injection !== undefined ? injection : info.state.revision;
    let action: "supersede" | "skip" = "supersede";
    let skipReason: string | undefined;
    if (bucket === "stale_other" && !opts.all) {
      action = "skip";
      skipReason = "requires_--all";
    }
    classified.push({
      sessionId: info.state.sessionId,
      dir: info.dir,
      state: info.state,
      scannedRevision,
      bucket,
      action,
      skipReason,
    });
  }

  const toSupersede = classified.filter((c) => c.action === "supersede");
  const skippedPreLock = classified.filter((c) => c.action === "skip");

  // --- Dry run ---
  if (opts.dryRun) {
    return renderRepairSummary(toSupersede, skippedPreLock, [], { mutated: 0 });
  }

  // --- Confirmation ---
  if (toSupersede.length > 0 && !opts.yes) {
    const isTty = (stdin as { isTTY?: boolean }).isTTY === true;
    if (!isTty) {
      throw new Error("session repair requires --yes when stdin is not a TTY.");
    }
    stdout.write(`Supersede ${toSupersede.length} session(s)? [y/N] `);
    const answer = (await readOneLine(stdin)).trim();
    if (!/^y(es)?$/i.test(answer)) {
      return "Repair aborted by user.";
    }
  }

  // --- Mutation under lock ---
  let mutated = 0;
  const mutationSkipped: { sessionId: string; reason: string }[] = [];

  if (toSupersede.length > 0) {
    await withSessionLock(root, async () => {
      for (const c of toSupersede) {
        if (!existsSync(c.dir)) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "directory_missing" });
          continue;
        }
        const fresh = readSession(c.dir);
        if (!fresh) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "state_unreadable" });
          continue;
        }
        if (fresh.status !== "active") {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "not_active" });
          continue;
        }
        if (fresh.revision !== c.scannedRevision) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "state_changed_during_repair" });
          continue;
        }
        if (c.bucket === "finished_orphan") {
          const still = await isFinishedOrphan(fresh, c.dir, root);
          if (!still) {
            mutationSkipped.push({ sessionId: c.sessionId, reason: "no_longer_orphan" });
            continue;
          }
        } else if (!isLeaseExpired(fresh)) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "lease_refreshed" });
          continue;
        }

        const terminationReason =
          c.bucket === "finished_orphan"
            ? "auto_superseded_finished_orphan"
            : "admin_recovery";
        const leaseExpiredMinutesAgo = fresh.lease?.expiresAt
          ? Math.max(
              0,
              Math.floor((Date.now() - new Date(fresh.lease.expiresAt).getTime()) / 60000),
            )
          : null;

        const nextState: FullSessionState = {
          ...fresh,
          status: "superseded",
          terminationReason,
        };

        writeSessionWithEvent(c.dir, nextState, {
          rev: fresh.revision + 1,
          type: "manual_repair",
          timestamp: new Date().toISOString(),
          data: {
            reason: terminationReason,
            bucket: c.bucket,
            leaseExpiredMinutesAgo,
            repairedBy: "cli",
          },
        });
        mutated++;
      }
    });
  }

  return renderRepairSummary(toSupersede, skippedPreLock, mutationSkipped, { mutated });
}

function renderRepairSummary(
  toSupersede: RepairCandidate[],
  skippedPreLock: RepairCandidate[],
  mutationSkipped: { sessionId: string; reason: string }[],
  result: { mutated: number },
): string {
  const lines: string[] = [];
  lines.push(
    `Repaired ${result.mutated} session(s). ${skippedPreLock.length + mutationSkipped.length} skipped.`,
  );
  if (toSupersede.length > 0) {
    lines.push("");
    lines.push("Planned:");
    for (const c of toSupersede) {
      lines.push(`  ${c.sessionId} (${c.bucket})`);
    }
  }
  if (skippedPreLock.length > 0) {
    lines.push("");
    lines.push("Skipped (pre-lock):");
    for (const c of skippedPreLock) {
      lines.push(`  ${c.sessionId} (${c.skipReason ?? "unknown"})`);
    }
  }
  if (mutationSkipped.length > 0) {
    lines.push("");
    lines.push("Skipped (under lock):");
    for (const m of mutationSkipped) {
      lines.push(`  ${m.sessionId} (${m.reason})`);
    }
  }
  return lines.join("\n");
}

async function readOneLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const onData = (chunk: Buffer | string) => {
      if (done) return;
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        done = true;
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = () => {
      if (done) return;
      done = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      resolve(buf);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

// ---------------------------------------------------------------------------
// session delete
// ---------------------------------------------------------------------------

export interface DeleteOpts {
  yes: boolean;
}

export async function handleSessionDelete(
  root: string,
  selector: string,
  opts: DeleteOpts,
): Promise<string> {
  const res = resolveSessionSelector(root, selector);
  if (res.kind === "invalid") throw new Error(res.reason);
  if (res.kind === "not_found") throw new Error(`Session ${selector} not found`);
  if (res.kind === "ambiguous") {
    throw new Error(
      `Session selector "${selector}" matches ${res.matches.length} sessions: ${res.matches.join(
        ", ",
      )}. Use a longer prefix.`,
    );
  }
  if (!opts.yes) {
    throw new Error("session delete requires --yes (destructive, removes the session directory).");
  }

  // A version skew does NOT block delete. This is the escape hatch, and refusing
  // here would leave an operator with a directory they cannot remove through the
  // CLI at all. But it is the one case where nothing established that the thing
  // being destroyed was broken, so say so (ISS-897) -- in text written for a
  // deletion that already happened. `describeIncompatible` ends in "do NOT
  // delete it", which is right where it stops an action and is two contradictory
  // instructions when printed underneath a completed irreversible one.
  //
  // Derived UNDER THE LOCK, from a fresh read. The pre-lock resolution is a
  // snapshot the code below already refuses to trust for the active check, and
  // the same gap runs both ways here: a file that becomes incompatible in the
  // window is deleted with no warning at all, and one that stops being
  // incompatible is deleted under a warning describing a revision that no longer
  // existed. The confirmation has to describe the bytes that were actually
  // removed.
  const incompatibleWarningFor = (dir: string): string => {
    const read = readSessionStrict(dir);
    if (read.ok) return "";
    const cause: IncompatibleCause | null =
      read.failure.kind === "version-skew"
        ? { cause: "newer", writerVersion: read.failure.writerVersion }
        : read.failure.kind === "unreadable" && read.failure.reason === "unsupported-version"
          ? { cause: "unsupported", rawVersion: read.failure.rawVersion }
          : null;
    if (cause === null) return "";
    return (
      "\nWarning: that session carried a `schemaVersion` this build does not support " +
      `(${incompatibleVersionDetail({ ...cause, readerVersion: CURRENT_SESSION_SCHEMA_VERSION })}). ` +
      "Its fields were never interpreted here, so neither corruption nor soundness was established, and whether a " +
      "compatible reader could have read it is unknown. It was removed because you asked for it explicitly."
    );
  };

  return withSessionLock(root, async () => {
    if (!existsSync(res.dir)) {
      return `Session ${res.sessionId} already deleted.`;
    }

    // Always re-read under lock -- the corrupt flag observed during resolution
    // is stale by the time we hold the lock. A session that was corrupt at
    // resolution time may have been repaired in the gap; refuse to delete a
    // now-active session even if the pre-lock snapshot looked deletable.
    const fresh = readSession(res.dir);
    if (fresh && fresh.status === "active" && !isLeaseExpired(fresh)) {
      throw new Error(
        `Session ${res.sessionId} is active. Stop it first with 'session stop ${res.sessionId}'.`,
      );
    }

    // Before the directory goes, not after: the read has to happen while the
    // bytes are still there.
    const incompatibleWarning = incompatibleWarningFor(res.dir);
    deleteSessionDir(root, res.sessionId);
    return `Session ${res.sessionId} deleted.${incompatibleWarning}`;
  });
}
