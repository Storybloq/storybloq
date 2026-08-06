/**
 * Lightweight session scanner for status display (ISS-023).
 *
 * Extracts the minimum needed from .story/sessions/ without importing the
 * autonomous session RUNTIME -- no reader, no writer, no lock. It does import
 * `session-types` and `session-selector`, which are the shared leaf modules for
 * the schema constants and the containment predicate; taking a second copy of
 * either is how the two seams drift apart. The boundary is the I/O layer, not
 * the directory.
 */
import { statSync, lstatSync, readdirSync, readFileSync, type Dirent, type Stats } from "node:fs";
import { join, dirname } from "node:path";
import { isContainedSessionDir, SESSION_ID_REGEX } from "../autonomous/session-selector.js";
import {
  computeSessionDirAge,
  AGED_ANOMALY_WINDOW_MS,
  describeAddressableAgedAnomaly,
  describeUnaddressableAgedAnomaly,
} from "./session-age.js";
import { normalizeOwnerTask, type OwnerTask } from "../autonomous/client-profile.js";
import { WORKFLOW_STATES, CURRENT_SESSION_SCHEMA_VERSION } from "../autonomous/session-types.js";
import { CONTAINMENT_CHECKS } from "./containment-checks.js";
import { boundedList } from "./bounded-list.js";
import { safeJson } from "./safe-json.js";

export type SessionLeaseState = "live" | "expired" | "missing" | "invalid";

/**
 * The four-way lease classification the guard's whole decision matrix turns
 * on (ISS-911). Extracted so the scanner and the CLI derive it from ONE
 * computation and cannot drift: an operator misread exactly the
 * active-vs-resumable-expired distinction during a live recovery because
 * `session list` showed only a relative expiry and left the STATE to
 * inference (N-097, operator 4).
 *
 * `isLeaseExpired` is not usable for this: it folds missing, invalid and
 * expired into one `true`, and the difference between "expired" (a
 * determinate observation) and "missing"/"invalid" (never established) is
 * load-bearing for the guard (ISS-897 lease grouping).
 *
 * An empty string classifies as missing, matching the scanner's original
 * falsy check. A lease expiring exactly NOW is expired, not live.
 */
export function deriveLeaseState(expiresAt: unknown, now: number = Date.now()): SessionLeaseState {
  if (typeof expiresAt !== "string" || expiresAt === "") return "missing";
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return "invalid";
  return t <= now ? "expired" : "live";
}

export interface ActiveSessionSummary {
  readonly sessionId: string;
  /**
   * The on-disk directory name (T-446).
   *
   * `sessionId` is file content, so it can differ from the directory it lives
   * in. `resolveSessionSelector` resolves DIRECTORY names, which makes this the
   * selector `storybloq session ...` prefers; guide and MCP calls still take
   * `sessionId`. Rendering only one of the two hands an operator a selector that
   * may not resolve.
   *
   * Not a guarantee of acceptance: this is copied verbatim from the directory
   * entry and never validated, so a legacy or hand-created directory whose name
   * fails the selector's own format check appears here and is still rejected.
   * Treat it as the address to inspect, not as a promise the CLI will take it.
   */
  readonly sourceDir: string;
  readonly state: string;
  readonly mode: string;
  readonly ticketId: string | null;
  readonly ticketTitle: string | null;
  readonly ownerTask?: OwnerTask | null;
  readonly leaseExpiresAt?: string | null;
  readonly leaseState?: SessionLeaseState;
  readonly compactPending?: boolean;
}

/**
 * How a diagnostic bears on ownership (ISS-897).
 *
 * Only `omission` conceals: the record vanishes, so a caller cannot tell
 * "nothing is running" from "something is running and I could not read it",
 * which is ISS-554's failure one layer down. The next three describe records
 * the scanner ADMITTED to a reported population, so treating them alike would
 * fail closed with no hazard behind it. The fifth, `aged-anomaly`, is neither:
 * it admits no session record at all (the scan found no readable state.json
 * here), and once aged past the classification window it is TREATED as not
 * concealing one, as a matter of policy rather than proof --
 * see its own entry below and `AGED_ANOMALY_WINDOW_MS` (session-age.ts) for
 * why "past the window" is a policy statement, not a proof.
 *
 * Admission is not survival. Deduplication runs downstream in
 * `classifySessionGuard`, after this scan, so an admitted record can still be
 * dropped before it is classified -- in which case its directory is accounted
 * for through the collision report rather than through the session list. No
 * annotation below may claim the record it names received a verdict.
 *
 * - `omission`     an observation GAP. Either an entry the scan saw is absent
 *                  from the reported populations, or enumeration itself failed
 *                  and records may never have been observed at all -- the
 *                  second establishes that something COULD be concealed, not
 *                  that any record exists. Ownership is unknowable either way.
 * - `normalized`   the record is admitted with one corrupt field silently
 *                  substituted, and is classified if it survives
 *                  deduplication. Nothing about ownership is unknown -- only
 *                  that the field was corrupt.
 * - `undetermined` the record is admitted carrying a value that cannot be
 *                  trusted. If it survives deduplication the guard already
 *                  answers `unverifiable` for it; what was missing is WHY.
 *                  Some kinds are stronger than that: `owner-task-undetermined`
 *                  withholds the AGGREGATE from its diagnostic alone, so it
 *                  still blocks when the record it names was dropped.
 * - `collision`    two directories carry the same embedded `sessionId`. Both
 *                  are reported here; the guard deduplicates them per Step 0.5.
 * - `aged-anomaly` an observed filesystem anomaly -- a directory with no
 *                  `state.json` and no descendant touched within the
 *                  classification window -- that admits no session record and
 *                  is treated by policy as non-blocking, WITHOUT asserting it
 *                  conceals nothing. Age is not proof of debris and does not
 *                  establish the absence of a suspended creator; it only
 *                  stops this one directory from withholding the aggregate
 *                  forever. Reported, never `concealing`, and never counted
 *                  toward `incomplete` scan completeness -- unlike `omission`,
 *                  which this would otherwise be indistinguishable from and
 *                  would wedge every guard call on its account permanently.
 */
export type SessionDiagnosticCategory =
  | "omission"
  | "normalized"
  | "undetermined"
  | "collision"
  | "aged-anomaly";

/**
 * Every kind THIS build knows how to act on, WITH the category each one carries
 * (ISS-897).
 *
 * A table rather than a bare union, for the same reason `category` is carried as
 * data: the downstream blocking rules match EXACT kinds (`owner-task-undetermined`
 * withholds the aggregate, `duplicate-session-id` carries the collision set), so
 * a diagnostic whose kind this build does not recognize cannot be acted on even
 * when every other field is well-formed. Treating one as harmless is a fail-open
 * -- a future `owner-fault-of-some-new-shape` would pass validation, trigger no
 * rule, leave completeness `complete`, and let the aggregate rise to `continue`.
 *
 * The PAIRING is the part that has to be data. Validating the two fields
 * separately accepts `{ kind: "state-unreadable", category: "normalized" }`:
 * both values are recognized, so the entry is usable, so completeness stays
 * `complete` -- while that kind means a session was concealed and no rule fires
 * on a `normalized` entry to say so. A payload that is merely wrong, not even
 * hostile, silently raises the verdict. One kind means one category, and the
 * only way two consumers cannot disagree about which is to write it once.
 *
 * Note `status-undetermined`: the NAME says undetermined and the CATEGORY is
 * `omission`, because the record is dropped rather than admitted. That is why
 * this is an enumerated table and not a rule about suffixes.
 *
 * The union type below is DERIVED from this table, so a kind cannot be added to
 * one without the other. Adding it to the set alone used to be enough to make
 * runtime validation accept a kind that the typed switches downstream do not
 * handle.
 */
export const DIAGNOSTIC_KIND_CATEGORY = {
  "sessions-dir-unreadable": "omission",
  "entry-not-a-directory": "omission",
  "entry-not-contained": "omission",
  "state-missing": "omission",
  "state-unreadable": "omission",
  "state-invalid-json": "omission",
  "state-not-an-object": "omission",
  "state-version-skew": "omission",
  "status-undetermined": "omission",
  "unadmitted-lease-undetermined": "omission",
  /**
   * A record with an UNSUPPORTED `schemaVersion` that the field-based gates
   * would otherwise have retired in silence (ISS-897).
   *
   * `omission`, and that is the whole point. The two gates that discard a record
   * without a word -- a non-active `status`, a `SESSION_END` `state` -- read two
   * fields under a schema the file does not claim. An older schema can have used
   * either string differently, so "this session is finished" is precisely the
   * conclusion that cannot be drawn here, and drawing it silently removes a
   * possibly-live session from both populations AND from the diagnostics, which
   * lets the aggregate go permissive over it.
   *
   * Its sibling `schema-version-undetermined` is `undetermined` because there
   * the record IS reported; here it is not, so the category has to say a record
   * went missing.
   */
  "unadmitted-schema-version-undetermined": "omission",
  "unadmitted-state-undetermined": "omission",
  "unadmitted-compact-pending-undetermined": "omission",
  "owner-task-undetermined": "undetermined",
  "state-undetermined": "undetermined",
  "lease-undetermined": "undetermined",
  "schema-version-undetermined": "undetermined",
  "mode-normalized": "normalized",
  "session-id-invalid": "normalized",
  "duplicate-session-id": "collision",
  /**
   * A `state-missing` directory aged past `AGED_ANOMALY_WINDOW_MS` (ISS-945).
   *
   * `aged-anomaly`, not `omission`: `completenessFromDiagnostics`
   * (session-guard.ts) forces `incomplete` on ANY `omission` entry
   * unconditionally, so a directory this old would wedge every
   * `storybloq_session_guard` call forever -- the exact failure this kind
   * exists to relieve. It is also not one of the three admitted-record
   * categories: the scan found no readable state.json at this path. See
   * `SessionDiagnosticCategory`'s doc for the full doctrine.
   */
  "state-missing-aged": "aged-anomaly",
} as const satisfies Record<string, SessionDiagnosticCategory>;

export type SessionScanDiagnosticKind = keyof typeof DIAGNOSTIC_KIND_CATEGORY;

/** Membership only, for callers that do not need the category. */
export const KNOWN_DIAGNOSTIC_KINDS: ReadonlySet<string> = new Set(
  Object.keys(DIAGNOSTIC_KIND_CATEGORY),
);

/**
 * The fields every diagnostic carries, whatever its kind.
 *
 * `kind` and `category` are NOT here: they are bound together by
 * `SessionScanDiagnostic` below, so the pair cannot be constructed wrongly.
 */
interface SessionScanDiagnosticFields {
  /**
   * The raw session directory name. Null only for a fault against the collection
   * itself, where there is no entry to name.
   *
   * A CLI selector only when TWO things hold, and canonical syntax is just the
   * first. `resolveSessionSelector` needs the name to match `SESSION_ID_REGEX`
   * AND the path to still be a contained, real session directory. The scanner
   * admits a contained directory under any name -- see
   * `ActiveSessionSummary.sourceDir` -- so a legacy or hand-created name appears
   * here and is refused by `storybloq session show` on the first count; an
   * `entry-not-a-directory` diagnostic can carry a perfectly canonical name and
   * be refused on the second, and a symlink or a containment failure is refused
   * the same way. Matching the regex is therefore not sufficient, and a consumer
   * that treats it as sufficient prints an instruction that fails.
   * `addressLine` in the CLI checks both; use `sourcePath` whenever either
   * fails.
   *
   * UNTRUSTED RAW DATA, exactly like `sourcePath` below: same origin, same
   * sinks, same rendering rule. It is stated in full there rather than twice.
   */
  readonly sourceDir: string | null;
  /**
   * The path most directly associated with the fault, which is NOT always a
   * `state.json`:
   *
   * - collection faults (`sessions-dir-unreadable`): the sessions root
   * - entry faults (`entry-not-a-directory`, `entry-not-contained`): the entry
   *   itself, which may be a file or a symlink
   * - collision faults (`duplicate-session-id`): a session directory
   * - everything else: that session's `state.json`
   *
   * UNTRUSTED RAW DATA, and the rendering depends on the SINK. This is returned
   * verbatim, and at the typed seam a caller supplies it, so an ESC or a
   * newline here forges output in an incident report. For a terminal or any
   * plain-text sink, `sanitizeDisplayPath` is enough. For anything a client may
   * RENDER -- a `format: "md"` payload, an MCP text response -- it is not:
   * `sanitizeDisplayPath` encodes control characters reversibly and
   * deliberately leaves `[`, `<`, `|` and `://` alone, so the path can still
   * author a link, an element or a table cell. Compose
   * `escapeMarkdownDocumentStrict(sanitizeDisplayPath(value))`, in that order,
   * because the Markdown pass doubles backslashes and must therefore run after
   * the encoding rather than before it. Verify containment before any
   * filesystem operation, for the same reason. NOT safe to append a filename
   * to, and not safe to label "state.json" in output.
   */
  readonly sourcePath: string;
  /** The embedded id when one was read before the fault, else null. */
  readonly sessionId: string | null;
  readonly reason: string;
  /**
   * `duplicate-session-id` only: every directory carrying the id, sorted.
   *
   * UNTRUSTED RAW DATA, per element, under the rendering rule on `sourcePath`.
   * This is the field a consumer reaches for when it wants to LIST the
   * participants, so it is the one most likely to be interpolated straight into
   * prose, and being an array does nothing to make its elements inert.
   */
  readonly conflictingSourceDirs?: readonly string[];
  /**
   * `state-missing-aged` only: a closed discriminator naming a CANDIDATE,
   * CLI-addressable removal command, present only when the scanner believed
   * one exists (ISS-945). A candidate, not a proof: this scanner's OWN
   * `sourceDir`/containment check backs it at the moment of classification,
   * but `SessionScanResult` arrives at a caller-supplied seam downstream, so a
   * consumer holding this field has no guarantee it still describes a real,
   * addressable, `state.json`-less directory -- it must independently
   * re-validate (shape, containment, real-directory, conclusive absence)
   * before treating it as authorization for anything, exactly as the skill's
   * own pre-relay procedure requires.
   *
   * Optional-but-exclusive, not merely optional-when-absent: it MUST be
   * absent on every kind other than `state-missing-aged`, and even on
   * `state-missing-aged` it is populated only when `sourceDir` matches
   * `SESSION_ID_REGEX` AND a fresh containment check still passes at
   * classification time. A legacy or hand-created non-canonical name can
   * carry this kind too (`RESERVED_SESSION_DIR_NAMES`'s doc above explains
   * why any name is admitted here) and `resolveSessionSelector` can never
   * resolve such a name -- advertising a command that cannot resolve would be
   * worse than naming none. `session-guard.ts` validates this field at
   * runtime in both directions; it is not enough that the type checker
   * accepts it, because `SessionScanResult` arrives at a caller-supplied seam.
   *
   * A closed discriminator, not free text: this is a field a consumer is
   * MEANT to act on, so `reason` (prose to quote, never an instruction to
   * follow, per the skill's own rule) is the wrong shape for it. Trusted
   * rendering code maps this discriminant to the full, caveated command text
   * -- age does not prove debris or the absence of a suspended creator, so the
   * rendered text is always conditional, never "correct and authorized".
   */
  readonly remedy?: "session-delete";
}

/**
 * One kind means one category, enforced by the COMPILER (ISS-897).
 *
 * Declaring the two as independent unions let `{ kind: "state-unreadable",
 * category: "normalized" }` typecheck. The guard rejects that at runtime, but
 * the scanner and every other typed producer could drift from the canonical
 * table with no error -- and this is a shape the scanner must never be able to
 * emit, not merely one the reader must survive. Distributing over the kinds
 * binds each one to the category `DIAGNOSTIC_KIND_CATEGORY` assigns it.
 */
export type SessionScanDiagnostic = {
  [K in SessionScanDiagnosticKind]: SessionScanDiagnosticFields & {
    readonly kind: K;
    /**
     * Carried as DATA rather than derived by a `switch` at each consumer, for
     * the same reason `PRE_OWNERSHIP_GATES` is a table: a new kind cannot be
     * added without classifying it, and two consumers cannot classify it
     * differently. The type now also makes them unable to disagree.
     */
    readonly category: (typeof DIAGNOSTIC_KIND_CATEGORY)[K];
  };
}[SessionScanDiagnosticKind];

export interface SessionScanResult {
  readonly activeSessions: readonly ActiveSessionSummary[];
  /**
   * COMPACT + `compactPending` + a NON-LIVE lease. Membership does NOT mean
   * resumable (ISS-897).
   *
   * Only `leaseState === "expired"` is a positively expired lease and therefore
   * a legitimate recovery candidate. `missing` and `invalid` mean the lease was
   * never established, which is undetermined, not expired -- recovering against
   * one offers recovery for a liveness nobody observed. The discriminator is on
   * every entry; the population name is what misleads.
   *
   * Every consumer must branch on `leaseState`, not on membership.
   * `classifySessionGuard` does (`classifyResumable` returns `unverifiable`
   * unless the lease is `expired`), and so does `formatStatus`. A scanner
   * diagnostic (`lease-undetermined`) accompanies each non-expired member so
   * the reason travels with the data.
   */
  readonly resumableSessions: readonly ActiveSessionSummary[];
  /**
   * Active-status, determinately-expired-lease, non-COMPACT (or stale-manual-
   * COMPACT) records the scan observed but could not place in either
   * `activeSessions` or `resumableSessions` (ISS-943).
   *
   * Membership proves only that the LEASE is determinately expired -- never
   * that the owning process is dead. A live process mid-long-turn, or one
   * whose PreCompact hook failed before writing COMPACT, legitimately holds
   * an expired lease. Do not name a consumer-facing concept from this
   * population that implies owner death; that inference belongs to
   * `readOwnerLiveness`, not to lease timing.
   *
   * OPTIONAL for the same reason `diagnostics` is: `classifySessionGuard` and
   * other consumers take a plain `SessionScanResult` that callers and tests
   * construct by hand; `?? []` at each consumer keeps those inputs valid.
   * `scanSessionSummaries` always populates it, sorted, empty when none.
   */
  readonly expiredLeaseSessions?: readonly ActiveSessionSummary[];
  /**
   * Everything the scan could not account for (ISS-897).
   *
   * OPTIONAL because `classifySessionGuard` is exported and takes a plain
   * `SessionScanResult`, which callers and tests build by hand; `?? []` at each
   * consumer keeps those inputs valid. `scanSessionSummaries` always populates
   * it, empty when the scan was clean.
   */
  readonly diagnostics?: readonly SessionScanDiagnostic[];
}

/**
 * Scan .story/sessions/ for active, non-expired sessions.
 * Returns an empty array if no sessions directory or no active sessions.
 */
export function scanActiveSessions(root: string): readonly ActiveSessionSummary[] {
  return scanSessionSummaries(root).activeSessions;
}

/**
 * Scan active sessions and compacted recovery candidates in one filesystem pass.
 * A live compacted session remains in activeSessions for backward compatibility.
 * Expired compacted sessions appear separately in resumableSessions.
 */
/**
 * Directory names under `.story/sessions` that are reserved, not sessions.
 *
 * `.lock` is `proper-lockfile`'s lock, taken via `mkdir` on the sessions root
 * (`withSessionLock`, session.ts), so it is a REAL directory with no
 * `state.json` for as long as any session write is in flight. `listAllSessions`
 * has always skipped it by name; the scanner never needed to until a missing
 * `state.json` started meaning something.
 *
 * Kept as an allowlist rather than a name-shape test on purpose: a session
 * directory can carry ANY name (`ActiveSessionSummary.sourceDir` documents that
 * a legacy or hand-created non-canonical name is admitted here and only later
 * rejected by the CLI selector), so treating an unrecognized name as
 * "not a session" would be exactly the concealment this file is closing.
 */
const RESERVED_SESSION_DIR_NAMES: ReadonlySet<string> = new Set([".lock"]);

/**
 * Whether a workflow state is one the state machine defines.
 *
 * Read from the SAME constant `session-guard.ts` uses, so the two cannot
 * disagree about what "determinate" means. It is consulted only for records the
 * guard will never see (see the unadmitted branch below); a record that reaches
 * the guard is gated there, not here.
 */
function isKnownWorkflowState(state: string): boolean {
  return (WORKFLOW_STATES as readonly string[]).includes(state);
}

/** Status values that positively mean a session is over, and may be dropped in silence. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "superseded"]);

/**
 * Does a reserved `.lock` directory hold nothing, so the exemption applies?
 *
 * `lstatSync`, not `existsSync`, and the distinction is the whole point.
 * `existsSync` follows symlinks and reports FALSE for a dangling one, so a
 * `.lock/state.json` symlink pointing nowhere would read as an empty lock and be
 * skipped -- a session-shaped directory concealed behind the one entry name the
 * scanner is allowed to ignore.
 *
 * Only an explicit ENOENT earns the exemption. Anything else -- a dangling
 * symlink, which lstat reports without following; an unsearchable directory; any
 * other errno -- means the entry could NOT be shown to be empty, so it falls
 * through to the ordinary path and is scanned or reported like any other
 * directory. Failing closed here costs a diagnostic on a genuinely odd lock;
 * failing open costs a hidden live session.
 */
/**
 * What an `lstat` of the `state.json` name ACTUALLY established (ISS-897).
 *
 * The same lstat-versus-follow distinction `lockIsEmpty` makes, asked of the
 * state file rather than the lock: `readFileSync` follows a symlink, so a
 * dangling `state.json` raises ENOENT exactly like an absent one, and only an
 * ENOENT from `lstat` proves the name is unused.
 *
 * Four outcomes, returned as four, not folded into a boolean. A boolean forces
 * every non-absent case to share one sentence, and the only sentence worth
 * having there is "it is a broken symlink -- repoint or remove it". That is
 * destructive advice, and it is false for the other two: `lstat` can find a
 * REGULAR file that appeared between the read and the probe (a race, where the
 * answer is "look again"), and it can fail with EACCES or EIO (where the answer
 * is "I could not look"). Telling an operator to remove a valid state.json is
 * the worst outcome this diagnostic can produce.
 *
 * `present-symlink`, NOT `dangling`. `lstat` does not follow, so it establishes
 * only that a symlink entry existed at the moment of the SECOND observation. It
 * says nothing about the target: the read may have failed for an unrelated
 * reason, or the whole path may have been replaced between the two calls. The
 * prose was corrected to stop claiming otherwise, but a discriminator still
 * named `dangling` invites the next reader to restore the destructive handling
 * on the strength of the name alone. A separate probe of the TARGET would be
 * needed to earn that word, and this is not it.
 */
type StateNameProbe =
  | { kind: "absent" }
  | { kind: "present-symlink" }
  | { kind: "present-not-symlink" }
  | { kind: "probe-failed"; code: string };

/**
 * What is at a session-entry path NOW: a real directory, something else, or
 * unknown.
 *
 * `probePath` collapses the middle case into `present`, which is right for
 * "does anything exist here" and wrong for the one caller that goes on to say
 * "this session DIRECTORY has no state.json". `lstat` does not follow, so a
 * symlink answers `other` rather than borrowing the type of whatever it points
 * at -- which is the case that made the claim false.
 */
type EntryKindProbe = "directory" | "other" | "absent" | "probe-failed";

function probeEntryKind(path: string): EntryKindProbe {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "other";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "probe-failed";
    // The same ancestor problem `probePath` has, and it lands harder here
    // because the caller SKIPS on `absent`. `lstat` follows every component
    // before the last, so this ENOENT is raised both by a vanished session
    // directory and by a `.story/sessions` that stopped resolving between
    // `readdirSync` and now. Skipping on the second would drop every entry in
    // the scan, in silence, and report the result as complete -- the exact
    // fail-open this issue exists to close, reached through the fix for a
    // different one.
    return ancestorsSupportAbsence(path) ? "absent" : "probe-failed";
  }
}

/**
 * Do this entry's ANCESTORS support a claim that it is gone? (ISS-897)
 *
 * The same walk `probePath` performs, and here for the same reason: `lstat`
 * follows every component before the last, so a dangling `.story` raises ENOENT
 * for the entry AND for `.story/sessions`, and stopping after one level accepts
 * the ambiguity as its own resolution. Climb through absent ancestors until one
 * exists; a DIRECTORY there proves the absence, and so does a SYMLINK that
 * resolves to one -- a symlinked `.story/sessions` is a supported layout, and
 * refusing to resolve it reports every genuinely absent session in such a
 * project as unreadable. Anything else -- a dangling link, a file, an
 * unreadable level -- leaves it unproven.
 *
 * It matters more on this path than on any other, because the caller SKIPS on a
 * proven absence. Getting it wrong drops every entry in the scan, in silence,
 * and reports the result as complete.
 */
function ancestorsSupportAbsence(entryPath: string): boolean {
  let current = entryPath;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return true;
    let info: Stats;
    try {
      info = lstatSync(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      current = parent;
      continue;
    }
    if (info.isDirectory()) return true;
    if (!info.isSymbolicLink()) return false;
    // Its own try: a dangling link's ENOENT means present-and-unresolvable,
    // not "this level is missing", so it must not rejoin the climb above.
    try {
      return statSync(parent).isDirectory();
    } catch {
      return false;
    }
  }
}

function probeStateName(statePath: string): StateNameProbe {
  try {
    return lstatSync(statePath).isSymbolicLink()
      ? { kind: "present-symlink" }
      : { kind: "present-not-symlink" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    return code === "ENOENT" ? { kind: "absent" } : { kind: "probe-failed", code };
  }
}

/**
 * Is the reserved `.lock` directory actually EMPTY (ISS-897)?
 *
 * The proper lockfile holds nothing, and that is the entire shape this
 * exemption covers. Asking instead whether `.lock/state.json` is absent answers
 * "empty" for a `.lock` that holds a pid file, a stray temp file, or a session
 * directory created a moment before its state write -- so the one case the
 * exemption is not meant to hide was the one it hid.
 *
 * Enumeration is also the stricter probe: any error means emptiness was not
 * ESTABLISHED, and an unestablished exemption has to fail toward reporting.
 * The caller has already required a real directory via `entry.isDirectory()`,
 * which `readdirSync` reports without following links.
 */
function lockIsEmpty(lockDir: string): boolean {
  try {
    return readdirSync(lockDir).length === 0;
  } catch {
    return false;
  }
}

/**
 * The embedded `sessionId`, or null when it is not one (ISS-897).
 *
 * `typeof x === "string"` was the whole test, and it is the wrong contract:
 * `SessionStateSchema` requires a UUID, so `""` and `"not-a-session-id"` are
 * rejected by every strict reader while this scanner accepted them as identity.
 * That is not cosmetic -- the value becomes the DEDUPLICATION key and the
 * correlation key the guard matches diagnostics on, so an empty string could
 * collapse two unrelated records into one collision, and a hand-edited value
 * could correlate a diagnostic to a session it has nothing to do with.
 *
 * Rejecting it here routes the record through the same substitution a missing
 * id already takes -- the directory name stands in, and `session-id-invalid`
 * records that it did -- which is `normalized`, not concealment: the record is
 * still admitted and still gets its ordinary ownership verdict.
 */
function normalizeEmbeddedId(raw: unknown): string | null {
  return typeof raw === "string" && SESSION_ID_REGEX.test(raw) ? raw : null;
}

export function scanSessionSummaries(root: string, now: number = Date.now()): SessionScanResult {
  const sessDir = join(root, ".story", "sessions");
  const diagnostics: SessionScanDiagnostic[] = [];

  /**
   * The category is DERIVED, not passed (ISS-897).
   *
   * It used to be a parameter, which meant every call site restated it and any
   * one of them could restate it wrongly -- the scanner would then emit a pair
   * the guard is now obliged to reject as impossible. Reading it out of
   * `DIAGNOSTIC_KIND_CATEGORY` makes that unrepresentable at the only place
   * diagnostics are constructed, and the generic keeps the returned object
   * narrowed to the one union member for that kind.
   */
  const note = <K extends SessionScanDiagnosticKind>(
    kind: K,
    sourceDir: string | null,
    sourcePath: string,
    sessionId: string | null,
    reason: string,
    conflictingSourceDirs?: readonly string[],
    remedy?: "session-delete",
  ): void => {
    diagnostics.push({
      kind,
      category: DIAGNOSTIC_KIND_CATEGORY[kind],
      sourceDir,
      sourcePath,
      sessionId,
      reason,
      ...(conflictingSourceDirs ? { conflictingSourceDirs } : {}),
      ...(remedy ? { remedy } : {}),
    } as SessionScanDiagnostic);
  };

  let entries: Dirent[];
  try {
    entries = readdirSync(sessDir, { withFileTypes: true }) as Dirent[];
  } catch (err) {
    // ENOENT is the only errno that CAN mean "nothing has ever run here". Every
    // other one (ENOTDIR from a file at that path, EACCES) means the collection
    // exists and could not be enumerated, which is not the same answer.
    //
    // But ENOENT alone does not establish absence, for the same reason
    // `lockIsEmpty` above uses `lstat`: `readdirSync` FOLLOWS a symlink, so a
    // dangling `.story/sessions` link raises ENOENT while the path itself is
    // right there. Reporting that as a clean empty scan is the ISS-897 failure
    // at collection scale -- `free`, `complete`, and nothing to inspect, over a
    // sessions root that exists in an unusable form. `lstat` does not follow,
    // so it separates the two: silent only when the path is genuinely absent.
    // What `lstat` ACTUALLY established is kept, rather than collapsing every
    // outcome into "it is a symlink". lstat can also fail with EACCES or EIO,
    // and it can find a plain directory created between the two calls; neither
    // is a broken link, and a diagnostic that names one would send an operator
    // to repoint something that is not there. Only `isSymbolicLink()` earns
    // that sentence. Everything except an ENOENT from lstat still fails closed.
    let genuinelyAbsent = (err as NodeJS.ErrnoException).code === "ENOENT";
    // `sawSymlink`, not `dangling`: `lstat` does not follow, so this records
    // what the second observation FOUND, not a conclusion about the target.
    let sawSymlink = false;
    let probeCode: string | null = null;
    if (genuinelyAbsent) {
      try {
        sawSymlink = lstatSync(sessDir).isSymbolicLink();
        genuinelyAbsent = false;
      } catch (lerr) {
        probeCode = (lerr as NodeJS.ErrnoException).code ?? "unknown error";
        // The SAME ancestor ambiguity, at the collection level and with the
        // most to lose: an ENOENT here is raised both by a sessions directory
        // that was never created and by one whose `.story` parent is a dangling
        // symlink, and only the first is an empty project. Accepting the second
        // returns a clean, complete scan with no diagnostics over a collection
        // that cannot be read at all -- which is the top-level concealment this
        // whole issue exists to close.
        genuinelyAbsent = probeCode === "ENOENT" && ancestorsSupportAbsence(sessDir);
      }
    }
    if (!genuinelyAbsent) {
      note(
        "sessions-dir-unreadable",
        null,
        sessDir,
        null,
        sawSymlink
          ? "The sessions directory could not be enumerated, and a second look found a SYMLINK entry at that path, so no session could be observed at all. " +
            "This is NOT an absent sessions directory -- something is there. The two observations are not atomic, so this does not establish that the " +
            "link target is missing: it may have been replaced between them. Inspect the link and rerun the scan. Do not delete anything on this evidence."
          : (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "The sessions directory could not be enumerated (ENOENT), and a second look could not establish that it is absent " +
              `(${probeCode === null ? "a second look found a non-symlink entry there, so the path changed between the two observations" : `that check failed with ${probeCode}`}). ` +
              "Whether a session is running here cannot be established. Inspect the path directly."
            : `The sessions directory could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"}), so no session could be observed at all.`,
      );
    }
    return { activeSessions: [], resumableSessions: [], expiredLeaseSessions: [], diagnostics };
  }

  const activeSessions: ActiveSessionSummary[] = [];
  const resumableSessions: ActiveSessionSummary[] = [];
  const expiredLeaseSessions: ActiveSessionSummary[] = [];

  for (const entry of entries) {
    const statePath = join(sessDir, entry.name, "state.json");
    // Reserved ONLY in the shape `proper-lockfile` actually creates: a real
    // directory with nothing in it. Two ways to get this wrong, both silent:
    //
    //  - skipping the NAME alone also skips a SYMLINK called `.lock`, which
    //    readdir never follows and which can point at a live session
    //  - skipping any DIRECTORY called `.lock` also skips one that contains a
    //    valid `state.json`, and this scanner deliberately admits a contained
    //    session directory under ANY name (see `ActiveSessionSummary.sourceDir`),
    //    so `.lock` is a name a real session can legitimately have
    //
    // Requiring the directory to be EMPTY closes both -- and closes a third the
    // old `state.json`-absence probe left open: a `.lock` holding anything
    // else, including a session directory created a moment before its state
    // write, answered "this is a lock" and was skipped.
    if (RESERVED_SESSION_DIR_NAMES.has(entry.name) && entry.isDirectory() && lockIsEmpty(join(sessDir, entry.name))) {
      continue;
    }

    if (!entry.isDirectory()) {
      // A non-directory can never BE a session, whatever it is called, so its
      // mere presence conceals nothing -- diagnosing every one of them would
      // put any project with a `.DS_Store` into `unverifiable`. Two shapes are
      // positive evidence that something went wrong:
      //   - a symlink of ANY name: `readdirSync(withFileTypes)` does not follow
      //     links, so this is dropped before any read and may well point at a
      //     live session directory (T-251 refuses to read through it);
      //   - a session-SHAPED name on something that cannot be a session,
      //     which is a damaged or skewed write, not noise.
      if (entry.isSymbolicLink() || SESSION_ID_REGEX.test(entry.name)) {
        note(
          "entry-not-a-directory",
          entry.name,
          join(sessDir, entry.name),
          null,
          entry.isSymbolicLink()
            ? "A symbolic link in the sessions directory is never followed, so if it points at a live session that session was not observed."
            : "An entry named like a session id is not a directory, so it could not be read as one.",
        );
      }
      continue;
    }

    // T-251: drop symlink-escape entries before any filesystem read.
    if (!isContainedSessionDir(root, join(sessDir, entry.name))) {
      note(
        "entry-not-contained",
        entry.name,
        join(sessDir, entry.name),
        null,
        "This directory could not be CONFIRMED to resolve inside the sessions root, so it was refused before any read and whatever it " +
          "holds was not observed. The containment check is a single boolean: it is false when the path resolves outside the root, and " +
          "equally false when canonicalizing it failed (EACCES, EIO) or it vanished mid-scan. Do not read this as proof of an escape -- " +
          "inspect the path to find out which it is.",
      );
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(statePath, "utf-8");
    } catch (err) {
      // ENOENT here is NOT harmless. `createSession` mkdirs the session
      // directory and writes `state.json` only afterwards, so a directory with
      // no state file is the observable shape of a session being created -- and
      // is indistinguishable from one whose state file was deleted. Reserved
      // names are already gone by this point, and the sessions root is not a
      // general-purpose namespace, so anything left is unaccountable.
      const code = (err as NodeJS.ErrnoException).code;
      // An ENOENT from `readFileSync` does not establish that the file is gone:
      // it FOLLOWS symlinks, so a `state.json` whose link target was removed
      // raises the same errno while the entry is right there in the directory.
      // "This session directory has no state.json" then sends an operator to
      // recreate a file that already exists as a broken link, and they will
      // watch the write land somewhere else. `lstat` does not follow, so only an
      // ENOENT from it means the name is genuinely unused. Either way the record
      // is an `omission` and the scan is incomplete -- only the reason differs,
      // and the reason is the whole content of an operator-facing diagnostic.
      const probe = code === "ENOENT" ? probeStateName(statePath) : null;
      // A whole session directory deleted between `readdirSync` and this read
      // produces exactly this signature: ENOENT on the file, and no entry at
      // that name. It is an ordinary race, not a gap -- there is no session
      // there to conceal, so diagnosing it makes the scan `incomplete` and
      // blocks the guard on something that no longer exists. `readSessionStrict`
      // already draws this line (`missing` for a vanished directory,
      // `missing-state` for a present one), and the scanner has to draw it the
      // same way or the two disagree about one path.
      //
      // Only PROVEN absence of the directory is skipped. A probe that could not
      // look establishes nothing and falls through to the diagnostic below,
      // where the reason says so.
      //
      // A DIRECTORY, not merely something. `probePath` answers `present` for a
      // symlink too, and `readdirSync` does not re-stat -- so a directory
      // replaced by a dangling link between enumeration and this read passed as
      // `present` and got "this session directory has no state.json", a remedy
      // that would have someone write a state file through the link. The kind
      // is checked here for the same reason the non-directory branch checks it
      // earlier in this loop: the two must not disagree about one path.
      //
      // Kept, rather than tested and discarded, because it decides more than
      // whether to skip. An ENOENT from `lstat` on `state.json` is raised both
      // by a live directory with no state file in it AND by a directory that is
      // not there at all -- the errno cannot tell them apart. So it is this
      // probe, and only this probe, that entitles the sentence below to say
      // "this session directory has no state.json"; without a PRESENT answer
      // that claim is about a directory nothing established exists.
      const dirProbe = probe?.kind === "absent" ? probeEntryKind(join(sessDir, entry.name)) : null;
      if (dirProbe === "absent") continue;
      // `state-missing` is reserved for the ONE outcome that established the
      // name is unused; a PRESENT directory probe is what establishes it.
      // Handled separately, and FIRST, because it alone sub-classifies by age
      // into `state-missing-aged` (ISS-945) -- every other post-ENOENT outcome
      // below stays plain `state-unreadable`, `omission`, scan-incomplete.
      if (probe !== null && probe.kind === "absent" && dirProbe === "directory") {
        const candidateDir = join(sessDir, entry.name);
        const age = computeSessionDirAge(candidateDir, now);
        const aged = age.kind === "known" && age.ageMs >= AGED_ANOMALY_WINDOW_MS;
        if (!aged) {
          note(
            "state-missing",
            entry.name,
            statePath,
            null,
            "This session directory has no state.json. A session being created looks exactly like this, as does one whose state file was deleted.",
          );
          continue;
        }
        // Fresh, at classification time -- not trusted from anywhere else.
        // `entry.name` can be a legacy or hand-created non-canonical name
        // (RESERVED_SESSION_DIR_NAMES's doc above), and `resolveSessionSelector`
        // can never resolve one, so `session delete` cannot address it either.
        const addressable = SESSION_ID_REGEX.test(entry.name) && isContainedSessionDir(root, candidateDir);
        note(
          "state-missing-aged",
          entry.name,
          statePath,
          null,
          addressable ? describeAddressableAgedAnomaly(entry.name) : describeUnaddressableAgedAnomaly(),
          undefined,
          addressable ? "session-delete" : undefined,
        );
        continue;
      }
      // Every other post-ENOENT outcome is `state-unreadable` with a reason
      // describing what was actually seen. All of them are `omission` and all
      // of them make the scan incomplete -- the kind and the reason are what
      // an operator acts on, and neither may overclaim.
      const reason =
        probe === null
          ? `This session's state.json could not be read (${code ?? "unknown error"}), so whether a session is running here is unknown.`
          : probe.kind === "absent"
            ? dirProbe === "other"
              ? "This session's state.json is not there, and a second look found that the entry at this name is NOT a directory any more -- " +
                "`readdirSync` reported a directory and the probe did not, so the path was replaced between the two observations. Writing a " +
                "state.json here would follow whatever is there now. Inspect the path directly and rerun the scan. Do not delete anything."
              : "This session's state.json is not there, and a second look could not establish whether the session DIRECTORY is there either " +
                "(the probe failed rather than answering). So this is not established as a directory missing its state file: the whole directory " +
                "may have gone, or an ancestor may be unreadable. Inspect the path directly and rerun the scan. Do not create a state.json here and " +
                "do not delete anything."
            : probe.kind === "present-symlink"
              ? "This session's state.json could not be read, and a second look found a SYMLINK entry of that name. The file is NOT simply missing -- " +
                "an entry by that name exists -- so writing a new state.json here would follow that link somewhere else. The two observations are not " +
                "atomic, so this does not establish that the link target is missing; it may have been replaced between them. Inspect the link and " +
                "rerun the scan. Do not delete anything on this evidence."
              : probe.kind === "present-not-symlink"
                ? "This session's state.json could not be read, and a second look found a NON-SYMLINK entry of that name -- so the path changed " +
                  "between the two observations, whether at this name or through an ancestor. What kind of entry it is now was not " +
                  "determined. Nothing here is established as broken; rerun the scan. Do not delete anything."
                : `This session's state.json could not be read, and a second look could not establish what is at that path either (${probe.code}). ` +
                  "Whether a session is running here is unknown. Inspect the path directly; do not delete anything.";
      note("state-unreadable", entry.name, statePath, null, reason);
      continue;
    }

    let root_: unknown;
    try {
      root_ = JSON.parse(raw);
    } catch {
      note(
        "state-invalid-json",
        entry.name,
        statePath,
        null,
        "This session's state.json is not valid JSON, so whether a session is running here is unknown.",
      );
      continue;
    }

    // `JSON.parse("null")` succeeds and returns null; reading a property off it
    // throws, which this function must never do.
    if (root_ === null || typeof root_ !== "object" || Array.isArray(root_)) {
      note(
        "state-not-an-object",
        entry.name,
        statePath,
        null,
        `This session's state.json parsed as ${root_ === null ? "null" : Array.isArray(root_) ? "an array" : typeof root_}, not a state object, so whether a session is running here is unknown.`,
      );
      continue;
    }
    const parsed = root_ as Record<string, unknown>;

    // The same version fence the strict reader applies, applied HERE too,
    // because this scanner has its own hand-rolled field reads and never goes
    // through that reader (ISS-897). Not one-directional: a version this build
    // does not support is fenced whichever side of the supported one it falls,
    // and an unsupported value that is not a number at all is fenced as well.
    //
    // Without it the two disagree about the same directory: `session list` and
    // `session show` say a newer-schema session needs an upgrade, while this
    // scanner reads `ownerTask`, `lease`, and `state` off it anyway and hands
    // the guard an ordinary record -- which can produce a PERMISSIVE verdict on
    // a session whose fields this build may be interpreting under the wrong
    // schema. A newer writer is exactly the case where field semantics may have
    // moved under us, so the record is reported and NOT classified: the scan
    // becomes incomplete and the guard answers `unverifiable`.
    //
    // NOT one-directional, and the earlier version of this comment argued that
    // it was. Three claims it made, and why each is wrong:
    //
    //  - "only a NEWER version can change what a field MEANS". An OLDER schema
    //    can too. A field that has been renamed, retyped, or given a different
    //    default between v0 and v1 is misread in exactly the same way, just in
    //    the other direction.
    //  - "a lower version is what an older storybloq wrote, so refusing it is a
    //    false stop". The legacy shape is the ABSENT field -- that is what this
    //    very block says two lines down, and what T-446's fixtures write. An
    //    explicit `0` is not evidence of a version that shipped.
    //  - "the choice is between admitting it and going blind". It is not.
    //
    // So the field is now split three ways rather than two:
    //
    //  - ABSENT              the documented legacy shape. Silent, classified.
    //  - a NEWER number      `state-version-skew`. Not classified at all: the
    //                        fields may mean something else, so there is nothing
    //                        safe to report about them.
    //  - anything else       present, and not a version this build supports:
    //                        a lower number, a string, null, an object. Admitted
    //                        AND blocked. The summary is kept, because a record
    //                        that vanishes tells the operator less than one that
    //                        is named -- "another task owns a live session here"
    //                        beats "the scan concealed something". But it is
    //                        `undetermined`, so the guard withholds the
    //                        aggregate rather than answering `continue` over a
    //                        file every strict reader in the product rejects.
    //
    // That third branch is the option the old comment did not consider: keeping
    // the record VISIBLE and refusing to act on it are not in tension.
    const writerVersion = parsed.schemaVersion;
    if (typeof writerVersion === "number" && writerVersion > CURRENT_SESSION_SCHEMA_VERSION) {
      note(
        "state-version-skew",
        entry.name,
        statePath,
        typeof parsed.sessionId === "string" ? parsed.sessionId : null,
        `This session was written by a newer storybloq (session schema v${writerVersion}; this build reads v${CURRENT_SESSION_SCHEMA_VERSION}), ` +
          "so its fields cannot be read under a schema this build understands and it is not classified. " +
          "This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound. " +
          "Restart your AI client to reload the MCP server, or upgrade storybloq so a compatible reader can look at it, then rerun. Do NOT delete it.",
      );
      continue;
    }
    const embeddedId = normalizeEmbeddedId(parsed.sessionId);


    // Recorded here and REPORTED in one of two places, because there are two
    // outcomes and they need different categories.
    //
    // If the record is admitted, `schema-version-undetermined` annotates it at
    // the admission point: the session is reported, so the category is
    // `undetermined` and nothing went missing. Emitting that kind up here was
    // wrong -- the gates below could still discard the record, leaving a
    // blocking diagnostic beside no session at all, which the guard reads as an
    // invariant violation.
    //
    // If instead a field-based gate would retire it, the branch immediately
    // below emits `unadmitted-schema-version-undetermined`, an `omission`. What
    // is NOT available is the third option the first cut took: letting those
    // gates drop it silently, on the strength of two fields read under a schema
    // the file does not claim.
    const versionUnsupported =
      writerVersion !== undefined && writerVersion !== CURRENT_SESSION_SCHEMA_VERSION;

    /**
     * The status this file MEANS, which is not always the status it carries.
     *
     * `SessionStateSchema` declares `.default("active")` on `status`, so a
     * legacy record written before the field existed parses as active in every
     * strict reader in this codebase. Reading `parsed.status` raw made this
     * scanner the one component that disagreed: an absent field is neither
     * `"active"` nor terminal, so it fell into `status-undetermined`, the
     * record was dropped from both populations, and the guard answered
     * `unverifiable` over a session every other reader admits without comment.
     * That is this issue's own failure mode -- a valid session concealed by the
     * code added to stop sessions being concealed.
     *
     * The default applies ONLY where the schema does. Under a `schemaVersion`
     * this build does not support there is no schema to take a default from,
     * and inventing `active` there would be the mirror mistake: asserting a
     * field's meaning under a version that was never interpreted.
     */
    const effectiveStatus =
      parsed.status === undefined && !versionUnsupported ? "active" : parsed.status;

    // BEFORE either field-based discard. Both of the gates below decide that a
    // record no longer bears on the project by reading `status` and `state` --
    // and under an unsupported schema this build cannot say what those strings
    // mean. Letting them retire the record in silence is the one outcome this
    // whole kind exists to prevent: the session vanishes from the populations,
    // no diagnostic marks it, completeness reads `complete`, and a live session
    // under an old schema becomes `free`.
    if (versionUnsupported && (parsed.status !== "active" || parsed.state === "SESSION_END")) {
      note(
        "unadmitted-schema-version-undetermined",
        entry.name,
        statePath,
        embeddedId,
        `This session's \`schemaVersion\` is ${safeJson(writerVersion)}, which is not one this build supports, and the fields that ` +
          `would show it is finished -- \`status\` (${safeJson(parsed.status)}) and \`state\` (${safeJson(parsed.state)}) -- were ` +
          "read under a schema the file does not claim, so what they mean here is not established. The record is NOT reported among the " +
          "sessions, because this build cannot interpret it; it is reported HERE instead, because retiring it on those fields would have " +
          "removed a possibly-live session in silence. Use a storybloq that supports that schema, then rerun; this annotation names no file to "
          + "edit, because the directory shown beside it is a DISPLAY rendering and only `storybloq_session_guard` carries the raw name with the "
          + "containment checks that make it safe to open. Do not delete it.",
      );
      continue;
    }

    if (effectiveStatus !== "active") {
      // Only a POSITIVELY terminal record may vanish in silence. An
      // unrecognized status is not terminal, it is unestablished. An ABSENT one
      // is neither: the schema defaults it to `active`, so it never reaches
      // here at all under a schema this build supports -- see `effectiveStatus`.
      if (typeof effectiveStatus !== "string" || !TERMINAL_STATUSES.has(effectiveStatus)) {
        note(
          "status-undetermined",
          entry.name,
          statePath,
          embeddedId,
          `This session's status is ${safeJson(effectiveStatus)}, which is neither "active" nor a terminal value, so whether it bears on this project could not be established.`,
        );
      }
      continue;
    }
    if (parsed.state === "SESSION_END") continue;

    const lease = parsed.lease as Record<string, unknown> | undefined;
    const leaseExpiresAt = typeof lease?.expiresAt === "string" ? lease.expiresAt : null;
    const leaseState = deriveLeaseState(lease?.expiresAt);

    const ticket = parsed.ticket as Record<string, unknown> | undefined;
    const rawOwner = parsed.ownerTask as Record<string, unknown> | undefined;
    const ownerTask = normalizeOwnerTask(rawOwner);

    const sessionMode = typeof parsed.mode === "string" ? parsed.mode : "auto";

    // PRESENT but unusable is not the same as ABSENT, and collapsing them is a
    // fail-open with a takeover behind it (ISS-897).
    //
    // A null `ownerTask` means "legacy session, no owner recorded", and the
    // guard treats a LIVE COMPACT legacy session as safe to auto-resume -- that
    // is the documented migration path. A session that HAS an owner whose id is
    // damaged is not that: it belongs to somebody. Normalizing it to null turns
    // `foreign-live` into `unowned-legacy`, and `monitor-only` into
    // `auto-resume`, which is taking over another task's live session. ISS-554
    // exactly, reached through a malformed field.
    //
    // Emitted below, and only once the record is ADMITTED -- see the note beside
    // the population push.
    const ownerUnreadable = rawOwner !== undefined && rawOwner !== null && ownerTask === null;
    const summary: ActiveSessionSummary = {
      sessionId: embeddedId ?? entry.name,
      sourceDir: entry.name,
      state: typeof parsed.state === "string" ? parsed.state : "unknown",
      mode: sessionMode,
      ticketId: typeof ticket?.id === "string" ? ticket.id : null,
      ticketTitle: typeof ticket?.title === "string" ? ticket.title : null,
      ownerTask,
      leaseExpiresAt,
      leaseState,
      compactPending: parsed.compactPending === true,
    };

    // `compactPending` decides membership in `resumableSessions` exactly as
    // `state` and the lease do, so it is a THIRD axis that can be undetermined
    // -- and the coercion above hides it: any present non-boolean becomes a
    // determinate `false`, so `compactPending: "true"` reads as "not pending"
    // rather than as "unreadable". Absent is determinate and means false; a
    // present non-boolean was written by something this reader does not
    // understand, and a COMPACT record it eliminates is a recovery candidate
    // that vanished.
    const compactPendingDeterminate =
      parsed.compactPending === undefined || typeof parsed.compactPending === "boolean";

    const isResumable = summary.state === "COMPACT" && summary.compactPending && leaseState !== "live";
    const admitted = leaseState === "live" || isResumable;
    if (leaseState === "live") activeSessions.push(summary);
    if (isResumable) resumableSessions.push(summary);

    // ADMITTED records only, for the same reason the ownership annotation below
    // is: this kind says "a record you can see was read under a schema it does
    // not claim". A record that was never reported has nothing for that sentence
    // to point at, and a diagnostic of this kind beside an empty population is
    // read as an invariant violation.
    //
    // "Admitted", not "will be classified": deduplication runs later, in the
    // guard, and can still drop this record. The reason text says only what is
    // established here.
    if (admitted && versionUnsupported) {
      note(
        "schema-version-undetermined",
        entry.name,
        statePath,
        // `summary.sessionId`, NOT `embeddedId`. When the embedded id is missing
        // or malformed the summary substitutes `sourceDir`, and the guard
        // correlates this diagnostic on `sessionId` AND `sourceDir` together --
        // so passing the raw null made a diagnostic this scanner really emits
        // fail to match its own admitted record, and get reported as an
        // invariant violation. The ownership diagnostic below already passes the
        // normalized value; these two must agree about what identifies a record.
        summary.sessionId,
        `This session's \`schemaVersion\` is ${safeJson(writerVersion)}, which this build does not support ` +
          `(it writes v${CURRENT_SESSION_SCHEMA_VERSION}; a session predating the field omits it entirely). ` +
          "The session was observed and admitted, and its fields were read by hand -- but this build cannot tell whether they " +
          "mean what it assumes, so the project-wide verdict is withheld. Nothing here establishes that the file is damaged " +
          "OR that it is sound: the version was checked before the fields were, so neither was determined. Use a storybloq that " +
          "supports that schema, then rerun. This annotation names no file to open: the directory shown beside it is a DISPLAY " +
          "rendering, and only `storybloq_session_guard` carries the raw name together with the containment and identity checks that " +
          "make it safe to open. Do not delete it.",
      );
    }

    // ADMITTED records only, and that condition is the whole correctness of this
    // diagnostic (ISS-897).
    //
    // An unreadable owner matters because the guard turns a null owner into
    // `unowned-legacy` and auto-resumes a live COMPACT one. A record admitted to
    // NEITHER population produces no verdict at all, so nothing is decided from
    // its owner and there is nothing to withhold -- while emitting it anyway
    // would block the aggregate of an UNRELATED valid session standing beside
    // it, and the rationale would claim the affected session is reported above
    // when it is not.
    //
    // Emitting it here rather than correlating later also keeps the typed guard
    // and mode A identical by construction: both see one diagnostic set, and
    // neither has to re-derive which records survived admission.
    // RECORD ANNOTATIONS, all gated on admission (ISS-897).
    //
    // The invariant these keep is the one the categories promise: `omission`
    // means a record went missing, and every OTHER category annotates a record
    // that is present in a reported population. A record admitted to neither is
    // reported by an `unadmitted-*` omission or is a determinate, deliberately
    // silent stale session -- either way an annotation about its fields would
    // describe a row the reader cannot see, and would put warnings on the
    // ordinary stale sessions every project accumulates.
    if (admitted && embeddedId === null) {
      // NOT concealment: the record is admitted and, if it survives
      // deduplication, receives its ordinary ownership verdict. What is lost
      // without this is the knowledge that the field was corrupt, because the
      // directory name silently stands in for it.
      note(
        "session-id-invalid",
        entry.name,
        statePath,
        null,
        "This session's `sessionId` is missing, or is not the UUID the session schema requires; the directory name is being " +
          "reported in its place. " +
          "The scanner admitted the record on that substituted id, and nothing about the substitution changes the ownership rule that will be " +
          "applied to it if it survives deduplication.",
      );
    }
    if (admitted && typeof parsed.state !== "string") {
      // Also not concealment. The guard's `unknown-workflow-state` gate already
      // answers `unverifiable` for the substituted value; the gate is NOT
      // re-derived here, only the reason it fires is recorded.
      note(
        "state-undetermined",
        entry.name,
        statePath,
        // `summary.sessionId`, for the same reason the schema-version note
        // above uses it: the summary substitutes `sourceDir` when the embedded
        // id is missing or malformed, and the guard correlates on `sessionId`
        // AND `sourceDir` together. Passing the raw `embeddedId` meant that a
        // record with BOTH an unusable id and an unusable `state` emitted a
        // diagnostic carrying null while its own admitted summary was keyed by
        // the directory name -- so the guard reported this scanner's own
        // diagnostic as matching neither population, an invariant violation
        // over a record that is right there.
        summary.sessionId,
        'This session has no usable `state`; "unknown" is being reported in its place, and no ownership rule applies to it.',
      );
    }
    if (admitted && parsed.mode !== undefined && typeof parsed.mode !== "string") {
      // The only hand-read field whose substitution changes NO verdict: `mode`
      // is carried through for display and no gate branches on it. Hence
      // `normalized` -- recorded so the substitution is not invisible, and
      // harmless so it must not make the scan incomplete.
      note(
        "mode-normalized",
        entry.name,
        statePath,
        summary.sessionId,
        `This session's \`mode\` is ${safeJson(parsed.mode)} rather than a string, so the scanner admitted the record reporting "auto" in its place. ` +
          "No ownership rule reads `mode`, so whatever verdict this record receives is unaffected -- but the mode shown for it is a substitution, not what is on disk.",
      );
    }
    if (admitted && ownerUnreadable) {
      note(
        "owner-task-undetermined",
        // `undetermined`, NOT `omission`. The category contract reserves
        // `omission` for a record that VANISHED, and this record is right there
        // in the population. What could not be determined is its OWNER. Filing
        // it as `omission` would make the aggregate rationale say entries could
        // not be accounted for and that further sessions may exist, both false.
        //
        // The aggregate is still withheld -- see `ownershipUndetermined` in
        // `classifySessionGuard`, which blocks on this the way the collision
        // rule blocks on a collapsed population. Completeness and blocking are
        // separate axes precisely so a truthful category does not cost safety.
        entry.name,
        statePath,
        summary.sessionId,
        "This session records an `ownerTask` that could not be read (its `client`, `id`, or `boundAt` is missing or invalid), " +
          "so the scanner admitted it with `ownerTask` normalized to null, and the guard classifies it as though no owner were " +
          "recorded IF it survives deduplication. The session itself was observed and admitted -- what is undetermined is " +
          "who owns it. That matters because a live COMPACT session with no recorded owner is auto-resumed, so acting on this " +
          "verdict could take over another task's session. This annotation names no file to edit: the directory shown beside it is a " +
          "DISPLAY rendering, and only `storybloq_session_guard` carries the raw name together with the containment checks that make it " +
          "safe to open. Run the guard and follow its ownership remedy.",
      );
    }

    if (isResumable && leaseState !== "expired") {
      // The population says "resumable"; this record's lease says its liveness
      // was never established. `classifyResumable` already declines to offer
      // recovery here -- this records WHY, which is what did not travel.
      note(
        "lease-undetermined",
        entry.name,
        statePath,
        summary.sessionId,
        `This session is reported as a recovery candidate but its lease is \`${leaseState}\`, not expired, so its liveness was never established and it is not resumable.`,
      );
    }

    if (leaseState !== "live" && !isResumable) {
      // Admitted by NEITHER population, so it vanishes entirely. Two independent
      // reasons that can be true, and the exclusion is only safe when both are
      // determinate:
      //
      //  - The LEASE. `expired` is a determinate observation, and every project
      //    accumulates stale sessions, so diagnosing those would put an ordinary
      //    project into `unverifiable`. `missing` and `invalid` mean the
      //    liveness of a record that still calls itself active was never
      //    established, which is not the same thing.
      //  - The STATE. Membership in `resumableSessions` is decided by comparing
      //    `state` to "COMPACT". A record whose state is undetermined fails that
      //    comparison silently and drops out, so the guard's
      //    `unknown-workflow-state` gate -- which exists precisely to stop an
      //    undetermined state being read as a valid non-COMPACT one -- NEVER
      //    RUNS on it. This is not re-deriving that gate: the gate applies to
      //    records that reach the guard, and this one never will.
      // ...and BOTH of those determinacy arguments are arguments about fields
      // read under a schema this build understands. Under one it does not, they
      // do not hold: an unsupported `schemaVersion` means `lease.expiresAt` and
      // `state` may not carry the meanings assumed here, so "expired" and "a
      // known non-COMPACT state" are not observations, they are guesses. That
      // shape -- active status, expired-looking lease, known-looking state --
      // clears the status/SESSION_END pre-gate above, is admitted by neither
      // population, and used to leave through this branch in complete silence,
      // taking the scan's `complete` with it.
      if (versionUnsupported) {
        note(
          "unadmitted-schema-version-undetermined",
          entry.name,
          statePath,
          summary.sessionId,
          `This session's \`schemaVersion\` is ${safeJson(writerVersion)}, which is not one this build supports, and it was admitted ` +
            `to neither reported population: its lease reads \`${leaseState}\` and its state reads ${safeJson(summary.state)}. Those two ` +
            "readings are what excluded it, and both were made under a schema the file does not claim, so neither is established. The record " +
            "is reported HERE rather than dropped, because dropping it would remove a possibly-live session with nothing left to say so. Use a " +
            "storybloq that supports that schema, then rerun. This annotation names no file to open: the directory shown beside it is a DISPLAY " +
            "rendering, and only `storybloq_session_guard` carries the raw name with the containment and identity checks that make it safe to " +
            "open. Do not delete it.",
        );
        continue;
      }
      const leaseDeterminate = leaseState === "expired";
      const stateDeterminate = isKnownWorkflowState(summary.state);
      // Ordered by which axis can actually decide membership. An undetermined
      // STATE comes first: a record whose state is unreadable cannot be reasoned
      // about at all, and naming the compactPending axis there would point at a
      // field that is not the problem.
      //
      // compactPending is checked ONLY for a known COMPACT state. For any other
      // known state, `isResumable` is already false BECAUSE of the state, and an
      // expired lease already determinately excludes the record from
      // `activeSessions` -- so the field cannot have changed either population,
      // and a diagnostic would be a false stop on a record that is fully
      // explicable. A leftover malformed `compactPending` on an expired
      // IMPLEMENT session is exactly that shape.
      if (!stateDeterminate) {
        note(
          "unadmitted-state-undetermined",
          entry.name,
          statePath,
          summary.sessionId,
          `This session is active and appears in neither reported population, and its state ${safeJson(summary.state)} is not a known workflow state, so whether it is a COMPACT recovery candidate could not be determined and no verdict covers it.`,
        );
      } else if (summary.state === "COMPACT" && !compactPendingDeterminate) {
        note(
          "unadmitted-compact-pending-undetermined",
          entry.name,
          statePath,
          summary.sessionId,
          `This session is active and appears in neither reported population, and its \`compactPending\` is ${safeJson(parsed.compactPending)} rather than a boolean, so whether it is a COMPACT recovery candidate could not be determined and no verdict covers it.`,
        );
      } else if (!leaseDeterminate) {
        // WHICH axis failed is in the kind, not only in the prose: a consumer
        // grouping by `kind` must not be told a lease is undetermined when the
        // lease is positively expired and something else is the problem.
        note(
          "unadmitted-lease-undetermined",
          entry.name,
          statePath,
          summary.sessionId,
          `This session is active and not terminal, but its lease is \`${leaseState}\` and it is not a COMPACT recovery candidate, so it appears in neither reported population and no verdict covers it.`,
        );
      } else {
        // Determinate on every axis that could have excluded it: the lease
        // reads positively `expired`, the state is a known workflow state,
        // and (for COMPACT specifically) `compactPending` was read
        // successfully. This is the cell ISS-943 exists to close -- previously
        // fell all the way through this chain in complete silence, admitted to
        // neither population, with no diagnostic and no trace. Membership here
        // proves only that the LEASE is expired; see the field's doc comment
        // on `SessionScanResult` for why this is not "orphaned" or "stale" in
        // the `findStaleSessions` sense.
        expiredLeaseSessions.push(summary);
      }
    }
  }

  activeSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  resumableSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  expiredLeaseSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  // Two directories carrying one embedded id. Reported here with BOTH
  // directories; `classifySessionGuard` still collapses them to one verdict,
  // because Step 0.5 says to deduplicate. Without this the surviving prose note
  // is the only trace, and a consumer would have to parse a sentence to learn
  // which directory to go and inspect.
  const byId = new Map<string, string[]>();
  for (const s of [...activeSessions, ...resumableSessions]) {
    const dirs = byId.get(s.sessionId);
    if (dirs) dirs.push(s.sourceDir);
    else byId.set(s.sessionId, [s.sourceDir]);
  }
  for (const [sessionId, dirs] of byId) {
    if (dirs.length < 2) continue;
    const sorted = [...new Set(dirs)].sort();
    if (sorted.length < 2) continue;
    note(
      "duplicate-session-id",
      sorted[0]!,
      join(sessDir, sorted[0]!),
      sessionId,
      // DESCRIPTIVE ONLY. This reason used to end in "remove every stale copy
      // with `storybloq session delete <dir> --yes`", which put a destructive
      // instruction on the wrong side of the trust boundary: a diagnostic is
      // passed through VERBATIM at the typed and Mode A seams, so a supplied
      // payload could carry a directory no deduplication ever touched and this
      // sentence would tell the operator to delete it -- rendered by ordinary
      // status output, with no guard verdict involved at all.
      //
      // `collisions` on the guard verdict carries the raw names for INSPECTION,
      // after the containment checks the skill requires -- and inspection is all
      // it authorizes: those checks establish that a name PARTICIPATED in the
      // collision, never which copy is stale. What this sentence is
      // entitled to do is NAME what was seen and say where to get an answer.
      //
      // The inspect hint stays per-name, because `resolveSessionSelector`
      // accepts only a canonical session id while the scanner admits a contained
      // directory under ANY name. Advertising `session show <dir>` for a legacy
      // or hand-created directory hands the operator a command that refuses to
      // resolve, at the moment they are trying to work out which session is real.
      // The COUNT is outside the bound and the LIST is inside it. A session id
      // can be embedded in any number of directories, so joining them all
      // produced a reason that a Markdown consumer then truncated at
      // `MAX_PROSE_LENGTH` -- cutting the containment checklist and the "do not
      // delete" sentence off the end, which is the safety-tail defect this
      // work exists to remove. Bounding the list here keeps the tail attached;
      // `conflictingSourceDirs` still carries every directory.
      `Session id ${sessionId} is embedded in ${sorted.length} different directories: ${boundedList(sorted, { noun: "directories" })}. ` +
        (sorted.every((dir) => SESSION_ID_REGEX.test(dir))
          ? "Every one of those names is shaped like a canonical session id, so `storybloq session show <dir>` will accept the NAME -- it can still " +
            "refuse, because it also requires the directory to be a contained, real session directory, which a name cannot establish. " +
            "Run the session guard first either way: its `collisions` field reports which record was kept and which was dropped, and it " +
            "carries raw names derived from the deduplication the guard itself performed. This diagnostic's `conflictingSourceDirs` is " +
            "raw too, but it is a scanner-supplied cross-check rather than a record of that event."
          : "At least one of these directory names is not a canonical session id, so the CLI selector cannot address it. Run the session " +
            "guard: its `collisions` field reports which record was kept and which was dropped, and carries raw names derived from the " +
            "deduplication it performed -- which the sanitized text above does not, though this diagnostic's `conflictingSourceDirs` " +
            "carries them as a cross-check.") +
        ` The names here are DISPLAY renderings, so before opening any of them each has to be checked: ${CONTAINMENT_CHECKS}. ` +
        "Nothing here establishes which copy is stale, so do not delete anything on this diagnostic alone.",
      sorted,
    );
  }

  diagnostics.sort(
    (a, b) => (a.sourceDir ?? "").localeCompare(b.sourceDir ?? "") || a.kind.localeCompare(b.kind),
  );
  return { activeSessions, resumableSessions, expiredLeaseSessions, diagnostics };
}
