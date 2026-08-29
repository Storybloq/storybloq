import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GateAckSchema, computeGateAckId, type GateAck, type GateAckPin } from "../models/gate-ack.js";
import type { ArrangementRole } from "../models/arrangement.js";
import { TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX, ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX } from "../models/types.js";
import { readBoundedRegularFile } from "./pin-utils.js";
import { sanitizeDisplayText } from "./display-text.js";
import { atomicCreate, atomicWrite, guardPath, serializeJSON } from "./project-loader.js";
import { ProjectLoaderError } from "./errors.js";
import { readdirSafe, verifyContainment, verifyDirIdentity } from "./readdir-safe.js";

/** A real ack record is a few hundred bytes; same reasoning as T-473's arrangement ceiling. */
const GATE_ACK_MAX_BYTES = 65_536;

export type GateAckLookupResult =
  | { status: "absent" }
  | { status: "unreadable"; reason: string }
  | { status: "contested"; ack: GateAck }
  | { status: "valid"; ack: GateAck };

/**
 * Targeted, single-file, permission-decision lookup -- deliberately NOT an
 * enumerate-the-directory-and-warn-and-skip reader like T-473's
 * `loadArrangementsSafe`. That asymmetry is intentional: arrangement data is
 * descriptive (a corrupt entry there degrades an announcement, never blocks
 * a write), whereas a gate-ack's presence is what UNLOCKS a transition, so
 * every failure mode short of a clean, matching, valid (or contested) record
 * reports `unreadable` or `absent` here -- never silently absorbed.
 *
 * Reads via `readBoundedRegularFile` (pin-utils.ts), not a separate
 * `lstatSync` check followed by a second read call: this reader's own
 * contract above requires it to never conflate "absent" with "unreadable",
 * and a two-syscall lstat-then-read pair reintroduces exactly the TOCTOU gap
 * that primitive's single open-fstat-read-on-one-fd design exists to close.
 */
export function findGateAck(root: string, query: {
  arrangementId: string;
  gateName: string;
  ticketRef: string;
  pin: GateAckPin;
  expectedAckRole: ArrangementRole; // deltas is deliberately NOT part of the query -- see gate-ack.ts's computeGateAckId
}): GateAckLookupResult {
  const id = computeGateAckId(query.arrangementId, query.gateName, query.ticketRef, query.pin);
  const path = resolve(root, ".story", "arrangement-acks", `${id}.json`);
  const fileResult = readBoundedRegularFile(path, GATE_ACK_MAX_BYTES);
  if (fileResult.status === "missing") return { status: "absent" };
  if (fileResult.status !== "ok") {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: ${sanitizeDisplayText(fileResult.reason)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileResult.bytes.toString("utf-8"));
  } catch {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: invalid JSON` };
  }
  const result = GateAckSchema.safeParse(parsed);
  if (!result.success) return { status: "unreadable", reason: `arrangement-acks/${id}.json: schema mismatch` };
  const rec = result.data;

  // Direct field comparison against the query -- the actual authorization
  // proof, independent of any property of the hash.
  if (
    rec.arrangementId !== query.arrangementId ||
    rec.gateName !== query.gateName ||
    rec.ticketRef !== query.ticketRef ||
    JSON.stringify(rec.pin) !== JSON.stringify(query.pin)
  ) {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: record fields do not match the queried authorization` };
  }
  // Recompute from the record's OWN fields too, catching a hand-edited field
  // left inconsistent with an unchanged filename/embedded id.
  const recomputed = computeGateAckId(rec.arrangementId, rec.gateName, rec.ticketRef, rec.pin);
  if (recomputed !== id || rec.id !== id) {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: content id does not match computed id` };
  }
  if (rec.ackRole !== query.expectedAckRole) {
    return {
      status: "unreadable",
      reason: `arrangement-acks/${id}.json: recorded ackRole (${rec.ackRole}) does not match the gate's required role (${query.expectedAckRole})`,
    };
  }
  if (rec.contested) return { status: "contested", ack: rec };
  return { status: "valid", ack: rec };
}

/** One directory entry's outcome from the shared scan below. */
export type GateAckScanEntry =
  | { readonly kind: "ok"; readonly ack: GateAck }
  | { readonly kind: "warning"; readonly file: string; readonly reason: string; readonly rawTicketRef: string | null };

/**
 * The raw result of ONE full `.story/arrangement-acks/` scan. Exported so a
 * multi-ref caller (`storybloq landings`) can scan exactly once and thread
 * the SAME snapshot through both `unattributedWarningsFromScan` and
 * `ticketAcksFromScan` for every ref it classifies -- see `scanGateAcksOnce`.
 */
export interface GateAckDirScan {
  readonly entries: readonly GateAckScanEntry[];
  readonly dirWarnings: readonly string[];
}

/**
 * Shared enumeration of every file in `.story/arrangement-acks/`, used by both
 * `readGateAcksForListing` (unscoped, unchanged since T-473) and
 * `readGateAcksForTicket` (T-477, ticket-scoped). Factored out so the two
 * callers never duplicate the readdir/read/parse walk or drift apart on it.
 *
 * For every entry that fails `GateAckSchema` validation, `rawTicketRef`
 * carries a BEST-EFFORT extraction of the raw JSON's own `ticketRef` field,
 * taken before schema validation and independent of whether the rest of the
 * record is well-formed -- most warning-producing files are near-valid
 * records (a bad pin shape, a wrong `ackRole`, an inconsistent id) whose
 * `ticketRef` is still a plain string, and that string is what lets a caller
 * attribute the warning to one ticket instead of poisoning every ticket's
 * coverage. It is `null` only when attribution is genuinely undeterminable:
 * the file was not valid JSON at all, or the parsed value is not an object,
 * or that object has no string `ticketRef` field.
 */
function scanGateAckDir(root: string): GateAckDirScan {
  const dir = resolve(root, ".story", "arrangement-acks");
  const scan = readdirSafe(dir);
  if (scan.warning !== null) {
    return { entries: [], dirWarnings: [`Could not read .story/arrangement-acks/: ${sanitizeDisplayText(scan.warning)}`] };
  }
  if (scan.dirents === null) return { entries: [], dirWarnings: [] };

  const entries: GateAckScanEntry[] = [];
  for (const entry of scan.dirents) {
    const file = entry.name;
    if (!file.endsWith(".json")) continue;
    if (!entry.isFile()) {
      entries.push({ kind: "warning", file, reason: "not a regular file, skipped", rawTicketRef: null });
      continue;
    }
    // Containment check (ISS-1053, T-478): a symlinked ancestor path
    // component swapped in between the listing and this read must not let
    // this read escape `dir`. Independent of `readBoundedRegularFile`'s own
    // leaf-symlink refusal below (O_NOFOLLOW with no prior resolution) --
    // this catches an ancestor-component swap, not a symlinked leaf.
    const containmentWarning = verifyContainment(dir, file);
    if (containmentWarning !== null) {
      entries.push({ kind: "warning", file, reason: sanitizeDisplayText(containmentWarning), rawTicketRef: null });
      continue;
    }
    const fileResult = readBoundedRegularFile(join(dir, file), GATE_ACK_MAX_BYTES);
    if (fileResult.status !== "ok") {
      entries.push({
        kind: "warning",
        file,
        reason: `${fileResult.status === "missing" ? "vanished during scan" : fileResult.reason}, skipped`,
        rawTicketRef: null,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileResult.bytes.toString("utf-8"));
    } catch {
      entries.push({ kind: "warning", file, reason: "invalid JSON", rawTicketRef: null });
      continue;
    }
    const candidateTicketRef =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).ticketRef === "string"
        ? ((parsed as Record<string, unknown>).ticketRef as string)
        : null;
    // "Recoverable" (per this module's corruption doctrine, above) means the
    // value could actually IDENTIFY a real ticket OR issue -- an empty string
    // or garbage text is technically a string but can never equal a real
    // canonical ticketRef, so treating it as attributed would silently drop
    // it from BOTH this ref's scoped warnings AND the project-wide
    // unattributed-corruption bucket, exactly the "confident wrong answer"
    // the doctrine exists to prevent.
    //
    // ISS-1032/ISS-1049 (Amendment A4): `ticketRef` (the field name predates
    // the WorkItemRef unification) now legitimately holds an issue ref too
    // (models/gate-ack.ts's `ticketRef: z.union([TicketRefSchema,
    // IssueRefSchema])`) -- recognizing only the ticket shape here left a
    // corrupted ISSUE-linked ack unrecoverable, which forced the OVER-BROAD
    // project-wide-corruption bucket (every ref in the run reads "unknown")
    // instead of the correctly SCOPED one (only that issue reads "unknown").
    const rawTicketRef =
      candidateTicketRef !== null && (
        TICKET_ID_REGEX.test(candidateTicketRef) || TICKET_CANONICAL_ID_REGEX.test(candidateTicketRef) ||
        ISSUE_ID_REGEX.test(candidateTicketRef) || ISSUE_CANONICAL_ID_REGEX.test(candidateTicketRef)
      )
        ? candidateTicketRef
        : null;
    const result = GateAckSchema.safeParse(parsed);
    if (!result.success) {
      entries.push({ kind: "warning", file, reason: "schema mismatch", rawTicketRef });
      continue;
    }
    if (file !== `${result.data.id}.json`) {
      entries.push({ kind: "warning", file, reason: "filename does not match record id, skipped", rawTicketRef });
      continue;
    }
    entries.push({ kind: "ok", ack: result.data });
  }
  if (scan.dirIdentity !== null) {
    const postScanWarning = verifyDirIdentity(dir, scan.dirIdentity);
    if (postScanWarning !== null) {
      // Any content read during a since-detected-swapped window is
      // retroactively suspect once the swap is confirmed -- discard every
      // entry already accumulated from this scan, not just the file being
      // read at the time.
      return { entries: [], dirWarnings: [`Could not read .story/arrangement-acks/: ${sanitizeDisplayText(postScanWarning)}`] };
    }
  }
  return { entries, dirWarnings: [] };
}

/**
 * Enumerate every ack for the CLI `gate-ack list` command -- informational,
 * warn-and-skip, mirrors `loadArrangementsSafe`'s posture exactly. Never
 * used for a permission decision (that is `findGateAck`'s job alone).
 *
 * Signature and behavior UNCHANGED by T-477 -- every existing caller
 * (`cli/commands/gate-ack.ts`) is unaffected.
 */
export function readGateAcksForListing(root: string): { acks: readonly GateAck[]; warnings: readonly string[] } {
  const { entries, dirWarnings } = scanGateAckDir(root);
  const acks: GateAck[] = [];
  const warnings: string[] = [...dirWarnings];
  for (const entry of entries) {
    if (entry.kind === "ok") {
      acks.push(entry.ack);
    } else {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(entry.file)}: ${entry.reason}`);
    }
  }
  return { acks, warnings };
}

/**
 * T-477: ONE full-directory scan, run ONCE per `storybloq landings` (or
 * similar) run and reused across every ref's `computeReviewCoverage` call --
 * never re-scanned per ref, which would defeat the point of computing this
 * once. Returns every warning whose owning ticket could not be determined at
 * all (unparseable JSON, no string `ticketRef`, or the directory itself
 * unreadable).
 *
 * Doctrine, per T-476's `loadRulingsSafe`/`hasUnrecoverableEntries`
 * precedent (`core/ruling-loader.ts`): corruption with a recoverable
 * identity taints only that identity; corruption with NO recoverable
 * identity taints every conclusion it could conceal, project-wide, because
 * the unreadable content might be hiding anything -- here, specifically, a
 * contest record for a commit this run is about to classify. `readGateAcksForTicket`
 * already refuses to let an unattributable warning taint any ONE ticket
 * (that would be arbitrary); the caller is instead responsible for taking
 * `computeReviewCoverage`'s `runHasUnattributedCorruption` flag from THIS
 * function so that a project-wide unknown-identity corruption forces every
 * gate-ack-eligible ref in the run to read `"unknown"` -- never a confident
 * `"matched"` or `"absent"` that an invisible contest record could be hiding
 * behind.
 */
export function scanForUnattributedGateAckWarnings(root: string): readonly string[] {
  return unattributedWarningsFromScan(scanGateAckDir(root));
}

/**
 * Runs the ONE full-directory scan a multi-ref caller (`storybloq landings`)
 * threads through every ref it classifies, via `unattributedWarningsFromScan`
 * and `ticketAcksFromScan` below -- never re-scanning `.story/arrangement-acks/`
 * per ref, and never letting two refs in the same run observe different
 * directory states (T-477 round-4 finding: `computeReviewCoverage` used to
 * call `readGateAcksForTicket`, which re-scans internally, once per ref).
 */
export function scanGateAcksOnce(root: string): GateAckDirScan {
  return scanGateAckDir(root);
}

/** Pure projection of a `GateAckDirScan` -- see `scanForUnattributedGateAckWarnings`'s doc comment for the doctrine this implements. */
export function unattributedWarningsFromScan(scan: GateAckDirScan): readonly string[] {
  const warnings: string[] = [...scan.dirWarnings];
  for (const entry of scan.entries) {
    if (entry.kind === "warning" && entry.rawTicketRef === null) {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(entry.file)}: ${entry.reason}`);
    }
  }
  return warnings;
}

/**
 * `found`: resolves to exactly one known item, by id.
 * `ambiguous`: resolves to MORE THAN ONE known item sharing that alias (a
 * duplicate display id -- Team Mode's own documented "permanently mixed
 * ledger" transient state, not a corruption of the ack itself).
 * `missing`: identifies no known item at all.
 */
export type RefResolution =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "ambiguous"; readonly ids: readonly string[] }
  | { readonly kind: "missing" };

/**
 * Resolves a raw ref string (e.g. a warning entry's `rawTicketRef`) to the
 * known item(s) it identifies. `ticketAcksFromScan` needs this rather than
 * plain string equality because this project's ledger is PERMANENTLY MIXED
 * (CLAUDE.md): a ticket's canonical id and its display id are different
 * strings for a legacy ticket, and a re-idented ticket can have PREVIOUS
 * display ids too -- a corrupt ack's raw `ticketRef` field could legitimately
 * name the same real ticket `computeReviewCoverage` was queried with, spelled
 * a different way. Built at the `storybloq landings` boundary from
 * `ProjectState.resolveTicketRef`/`resolveIssueRef` (canonical + current
 * display id + previous display ids, in one call, dispatched by the raw
 * ref's own shape -- Amendment A4); a caller with no `ProjectState` (this
 * module's own single-ticket tests) may omit it entirely.
 *
 * ISS-1032/ISS-1049 (Amendment A4, codex round-3 finding): `ambiguous` is
 * its own outcome, never collapsed into the same "missing" bucket. A
 * resolver that could only say "found" or "not found" made a genuinely
 * ambiguous alias (two issues sharing one display id) indistinguishable from
 * a totally unknown ref -- and `ticketAcksFromScan` routed BOTH to the
 * unscoped `unattributedWarnings` bucket, which `computeReviewCoverage`
 * never even reads (only `scopedWarnings` gates its verdict). The corrupted
 * ack then poisoned NEITHER candidate item's own coverage, each of which
 * read a confident `absent` instead of the `unknown` the doctrine requires
 * whenever a scoped warning could belong to THIS item.
 */
export type TicketRefResolver = (raw: string) => RefResolution;

/** The acceptor's ruling default (T-477 round-4 cap escalation): with no resolver, nothing can be confirmed as a DIFFERENT known ticket, so classification never excludes -- see `ticketAcksFromScan`. */
const NO_KNOWN_TICKETS: TicketRefResolver = () => ({ kind: "missing" });

/**
 * T-477: ticket-scoped ack listing for the review-coverage view. Unlike
 * `readGateAcksForListing`, a warning here only taints THIS ticket's coverage
 * when it is actually attributable to this ticket -- an unrelated ticket's
 * corrupt ack file must never make every OTHER ticket's coverage read
 * `"unknown"` (the round-3 finding this function exists to close: "one
 * unreadable unrelated gate-ack poison[s] coverage for every ticket").
 *
 * Attribution is ALIAS-SET membership, not string equality (T-477 round-4 cap
 * escalation, acceptor's ruling): a raw ref that `resolveTicketRef` maps to
 * THIS ticket's canonical id is scoped here regardless of which alias it was
 * spelled with; a raw ref that maps to a DIFFERENT known ticket is excluded
 * entirely, by design; a ticket-SHAPED raw ref that resolves to NO known
 * ticket at all (a deleted ticket, or text that merely looks ticket-shaped)
 * is FAIL-CLOSED into `unattributedWarnings` rather than silently excluded --
 * confident exclusion requires a positively confirmed different identity, not
 * merely the absence of a match to this one.
 *
 * A warning whose ticket cannot be determined at all (unparseable JSON, a
 * parsed value with no string `ticketRef`, or one that is not even
 * ticket-shaped) is neither included in `acks` nor attributed to `ticketRef`
 * -- it is fail-VISIBLE rather than fail-silent, returned separately as
 * `unattributedWarnings` so a caller can surface it as a project-level
 * diagnostic (e.g. in `storybloq landings` or `gate-ack list`) without
 * collapsing any specific ticket's `gateAckCoverage` to `"unknown"` over a
 * file that, for all this function can tell, may belong to a different
 * ticket entirely.
 */
export function ticketAcksFromScan(
  scan: GateAckDirScan,
  ticketRef: string,
  resolveTicketRef: TicketRefResolver = NO_KNOWN_TICKETS,
): { acks: readonly GateAck[]; scopedWarnings: readonly string[]; unattributedWarnings: readonly string[] } {
  const acks: GateAck[] = [];
  const scopedWarnings: string[] = [];
  const unattributedWarnings: string[] = [...scan.dirWarnings];
  for (const entry of scan.entries) {
    if (entry.kind === "ok") {
      if (entry.ack.ticketRef === ticketRef) acks.push(entry.ack);
      continue;
    }
    const message = `arrangement-acks/${sanitizeDisplayText(entry.file)}: ${entry.reason}`;
    if (entry.rawTicketRef === null) {
      unattributedWarnings.push(message);
      continue;
    }
    if (entry.rawTicketRef === ticketRef) {
      scopedWarnings.push(message);
      continue;
    }
    const resolution = resolveTicketRef(entry.rawTicketRef);
    if (resolution.kind === "found") {
      if (resolution.id === ticketRef) scopedWarnings.push(message);
      // else: resolved to a DIFFERENT known item -- excluded entirely, by design.
    } else if (resolution.kind === "ambiguous") {
      // ISS-1032/ISS-1049 (Amendment A4, codex round-3 finding): a duplicate
      // display id resolves to SEVERAL known items. Scoped here only when
      // THIS query's own ref is among them -- an ambiguity among some other,
      // unrelated group of items is still safely excluded for us, but each
      // of those OTHER items' own query would see itself among `ids` and get
      // scoped in turn. Fail-closed to "could be ours", never silently
      // dropped into the unscoped bucket `computeReviewCoverage` never reads.
      if (resolution.ids.includes(ticketRef)) scopedWarnings.push(message);
    } else {
      // Ticket/issue-shaped but resolves to no KNOWN item at all -- fail-closed,
      // not a confident "belongs to someone else".
      unattributedWarnings.push(message);
    }
  }
  return { acks, scopedWarnings, unattributedWarnings };
}

export function readGateAcksForTicket(
  root: string,
  ticketRef: string,
  resolveTicketRef: TicketRefResolver = NO_KNOWN_TICKETS,
): { acks: readonly GateAck[]; scopedWarnings: readonly string[]; unattributedWarnings: readonly string[] } {
  return ticketAcksFromScan(scanGateAckDir(root), ticketRef, resolveTicketRef);
}

/**
 * Idempotent create. Since the id is a pure function of
 * (arrangementId, gateName, ticketRef, pin) -- ackRole and deltas are
 * deliberately NOT id material -- two writes producing the same id are, by
 * construction, the same core authorization. `deltas` is the one field that
 * can legitimately vary and needs its own conflict rule:
 *   - existing record's deltas === incoming deltas (including both absent)
 *     -> no-op, return the existing record unchanged, never rewritten.
 *   - existing record's deltas !== incoming deltas -> throw. A second
 *     attempt to ack the identical pin with DIFFERENT ratification
 *     conditions is a genuine conflict between two acking attempts, not a
 *     retry, and must never be resolved by silently picking either one.
 */
export async function writeGateAckUnlocked(ack: GateAck, root: string): Promise<GateAck> {
  const parsed = GateAckSchema.parse(ack);
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "arrangement-acks", `${parsed.id}.json`);

  const existing = findGateAck(root, {
    arrangementId: parsed.arrangementId,
    gateName: parsed.gateName,
    ticketRef: parsed.ticketRef,
    pin: parsed.pin,
    expectedAckRole: parsed.ackRole,
  });
  if (existing.status === "valid" || existing.status === "contested") {
    if ((existing.ack.deltas ?? "") === (parsed.deltas ?? "")) return existing.ack;
    throw new ProjectLoaderError(
      "invalid_input",
      `gate-ack ${parsed.id} already exists with different deltas -- this is a conflict between two acking attempts, not a retry`,
    );
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await guardPath(targetPath, wrapDir);
  await atomicCreate(targetPath, serializeJSON(parsed));
  return parsed;
}

/** The one post-creation mutation an ack record permits (acceptance 6). */
export async function writeGateAckContested(id: string, reason: string, root: string): Promise<GateAck> {
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "arrangement-acks", `${id}.json`);
  const fileResult = readBoundedRegularFile(targetPath, GATE_ACK_MAX_BYTES);
  if (fileResult.status !== "ok") {
    throw new ProjectLoaderError("not_found", `gate-ack ${id} not found or unreadable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileResult.bytes.toString("utf-8"));
  } catch {
    throw new ProjectLoaderError("io_error", `gate-ack ${id} is not valid JSON`);
  }
  const result = GateAckSchema.safeParse(parsed);
  if (!result.success) throw new ProjectLoaderError("io_error", `gate-ack ${id} failed schema validation`);

  const updated = GateAckSchema.parse({ ...result.data, contested: true, contestedReason: reason });
  await guardPath(targetPath, wrapDir);
  await atomicWrite(targetPath, serializeJSON(updated));
  return updated;
}
