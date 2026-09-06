/**
 * T-432: the only part of review-stats that touches disk.
 *
 * Compute is pure over what this returns, which is what lets the honesty
 * properties be tested without a fixture tree. The job here is narrower and
 * harder than "read the files": it is to make sure an unavailable read never
 * becomes a number.
 *
 * FAILURES ARE CLASSIFIED BY SCOPE, NOT BY OPERATION. An earlier revision split
 * on which call failed, which is the wrong axis. What matters is how far the
 * uncertainty reaches: failing to list ONE KNOWN SESSION's artifact directory
 * hides no other session, while failing to list the ROOT hides whole sessions.
 * Same operation, different blast radius, so they cannot share a category.
 *
 * ONLY DEPENDENT POPULATIONS ARE SUPPRESSED. A failed `state.json` read does not
 * spoil a complete artifact reconstruction for the same session, because P1
 * never reads state. Suppressing it for sharing a session id would discard good
 * evidence over an unrelated defect.
 */
import { readdir, readFile, stat, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import type {
  FailureScope,
  P1Artifact,
  PopulationId,
  ScanFailure,
  ScanReport,
  ScanState,
} from "./review-stats-types.js";

/**
 * How the `landingDecision` field presented itself.
 *
 * THREE STATES, NOT TWO. `absent` (or the schema's `null` default) means no
 * decision was recorded, which is UNKNOWN rather than no-landing. `malformed`
 * means something IS there and cannot be read, which is a different thing again
 * and must count as invalid: collapsing it into `absent` would drop a record we
 * know exists out of the accounting entirely.
 */
export type LandingField = "absent" | "malformed" | "present";

/** A parsed session state, for the P2 metrics. Never used to fill P1. */
export interface P2Record {
  readonly root: string;
  readonly sessionId: string;
  readonly landingField: LandingField;
  readonly landingReason: string | null;
  readonly risk: string | null;
  readonly realizedRisk: string | null;
}

export interface ScanResult {
  readonly report: ScanReport;
  readonly p1: readonly P1Artifact[];
  readonly p2: readonly P2Record[];
  /** Session ids seen under more than one root. Reported, never deduplicated. */
  readonly overlaps: readonly SessionOverlap[];
}

export interface SessionOverlap {
  readonly sessionId: string;
  /**
   * Every root observed to hold this session id, INCLUDING one whose artifact
   * listing could not be read.
   *
   * Membership is session IDENTITY, which is established by the session
   * directory existing. Deriving it from the artifact map instead meant a root
   * entered only when its reviews directory enumerated, so a session copied
   * into two roots with one listing denied was reported as no overlap at all --
   * withholding the sharing that WAS observed because of what could not be read
   * about it.
   */
  readonly roots: readonly string[];
  /**
   * `matching-stored-hashes` when every artifact filename shared between the
   * roots carries an equal `_contentHash`.
   *
   * NOT "confirmed copy". An equal stored hash is a MATCHING CLAIM: a stale or
   * hand-edited record keeps its old hash, so the hash agreeing is weaker
   * evidence than the copies being identical, and the label says which one it
   * is.
   *
   * `no-shared-files` is a claim about ABSENCE and therefore needs every
   * holder's filenames, so it is never reported while a holder's listing is
   * unread; that case is `unknown`.
   */
  readonly agreement: "matching-stored-hashes" | "differing" | "unknown" | "no-shared-files";
  /**
   * Filenames held by at least two of these roots. A LOWER BOUND when
   * `holdersWithUnreadListing` is above zero.
   */
  readonly sharedFiles: number;
  /** Shared filenames whose known hashes disagree. */
  readonly differingFiles: number;
  /** Shared filenames where at least one copy has no stored hash to compare. */
  readonly unknownFiles: number;
  /**
   * Holders whose artifact filenames could not be enumerated at all, so their
   * contribution to the comparison is unknown rather than empty.
   */
  readonly holdersWithUnreadListing: number;
}

/**
 * What one root holds for one session id.
 *
 * `enumerated` is the difference between "this copy has no artifacts" and "we
 * could not find out", which is the same distinction the rest of the scanner
 * turns on. A confirmed-absent reviews directory is enumerated with no files;
 * a denied listing is not enumerated.
 */
interface SessionFiles {
  readonly enumerated: boolean;
  readonly files: Map<string, string | null>;
}

const SESSIONS_DIR = join(".story", "sessions");

/** Read concurrency. A damaged root fails alone; it never aborts the scan. */
const CONCURRENCY = 24;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function reasonOf(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  return err?.code ?? err?.message ?? String(e);
}

function isMissing(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "ENOENT";
}

/**
 * The landing table.
 *
 * TWO CORRECTIONS, both found by running against the fleet rather than by
 * reading code:
 *
 *  1. The plan says this table is "read from the type". It cannot be:
 *     `landingDecision.reason` is `z.string()`, free text with no enum. So it is
 *     read from the WRITER instead.
 *  2. The first attempt grepped for reason literals and matched two prose
 *     strings -- "Code review reached its hard ceiling of N rounds..." and its
 *     plan-review twin. Those belong to `pendingCeilingEscalation`, a DIFFERENT
 *     RECORD. Matching them classified nothing, because every one of the 10
 *     sessions in the fleet carrying `landingDecision` holds the slug below.
 *     A grep found the string; only the data found the record it lives on.
 *
 * One writer emits this field (`code-review.ts`, on a forced landing) and
 * `session-diagnostics.ts` already treats this same slug as the landing signal,
 * so the vocabulary is closed and shared rather than invented here. Anything
 * else is `invalid`: a reason we cannot classify, never evidence of no landing.
 */
export const LANDING_REASONS: readonly (readonly [string, RegExp])[] = [
  ["max-review-rounds-no-blocking", /^max_review_rounds_no_blocking$/],
];

export function classifyLandingReason(reason: string | null): string | null {
  if (reason === null) return null;
  for (const [id, pattern] of LANDING_REASONS) {
    if (pattern.test(reason)) return id;
  }
  return null;
}

interface RootScan {
  readonly root: string;
  readonly p1: P1Artifact[];
  readonly p2: P2Record[];
  readonly failures: ScanFailure[];
  readonly p1State: ScanState;
  readonly p2State: ScanState;
  /** Every DISCOVERED session id in this root, for overlap reporting. */
  readonly sessions: Map<string, SessionFiles>;
}

function fail(
  root: string,
  scope: FailureScope,
  path: string,
  reason: string,
  affects: readonly PopulationId[],
  sessionId?: string,
): ScanFailure {
  return sessionId === undefined
    ? { root, scope, path, reason, affects }
    : { root, scope, path, reason, affects, sessionId };
}

function parseArtifact(
  root: string,
  sessionId: string,
  fileName: string,
  raw: unknown,
): P1Artifact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.target !== "string" || typeof d.stage !== "string") return null;
  const severity = (d.severityCounts ?? null) as Record<string, unknown> | null;
  const findings = Array.isArray(d.findings) ? d.findings : [];
  return {
    root,
    sessionId,
    fileName,
    target: d.target,
    stage: d.stage,
    round: typeof d.round === "number" ? d.round : null,
    verdict: typeof d.verdict === "string" ? d.verdict : "",
    reviewerRaw: typeof d.reviewer === "string" ? d.reviewer : "",
    findingsCount: typeof d.findingsCount === "number" ? d.findingsCount : null,
    criticalCount:
      severity !== null && typeof severity.critical === "number" ? severity.critical : null,
    // An unparseable timestamp is as disqualifying for ordering as an absent
    // one, so it collapses to null HERE rather than reaching the compute path
    // as a string that sorts but means nothing.
    timestamp: parseTimestamp(d.timestamp),
    epochMs: parseEpoch(d.timestamp),
    contentHash: typeof d._contentHash === "string" ? d._contentHash : null,
    originClasses: findings.map((f) =>
      typeof f === "object" && f !== null ? (f as Record<string, unknown>).originClass : undefined,
    ),
    diffLines: typeof d.diffLines === "number" ? d.diffLines : null,
  };
}

function parseTimestamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/** The instant. What every comparison downstream uses. */
function parseEpoch(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

async function scanRoot(root: string): Promise<RootScan> {
  const p1: P1Artifact[] = [];
  const p2: P2Record[] = [];
  const failures: ScanFailure[] = [];
  const held = new Map<string, SessionFiles>();
  // Whether any reviews directory was successfully enumerated. Tracked apart
  // from `held`, which now also carries sessions whose listing FAILED: counting
  // those as "something was read" would turn an UNAVAILABLE population into a
  // PARTIAL one on the strength of a read that did not happen.
  let listedAny = false;
  const sessionsPath = join(root, SESSIONS_DIR);

  let entries: string[];
  try {
    entries = await readdir(sessionsPath);
  } catch (e) {
    if (isMissing(e)) {
      // Scanned, nothing present. Not a failure, and distinguishable from one:
      // EMPTY is a fact about the root, UNAVAILABLE is a fact about the scan.
      return { root, p1, p2, failures, p1State: "EMPTY", p2State: "EMPTY", sessions: held };
    }
    failures.push(fail(root, "root-discovery", sessionsPath, reasonOf(e), ["p1", "p2"]));
    // Nothing was read, so this is UNAVAILABLE rather than PARTIAL. The two are
    // not degrees of one thing: PARTIAL still has a usable numerator.
    return { root, p1, p2, failures, p1State: "UNAVAILABLE", p2State: "UNAVAILABLE", sessions: held };
  }

  const sessions: string[] = [];
  for (const name of entries) {
    try {
      const st = await stat(join(sessionsPath, name));
      if (st.isDirectory()) sessions.push(name);
    } catch (e) {
      // ROOT-DISCOVERY, not record: a failed stat leaves a NAME that may or may
      // not be a session, so whole sessions may be invisible.
      failures.push(fail(root, "root-discovery", join(sessionsPath, name), reasonOf(e), ["p1", "p2"]));
    }
  }

  await mapLimit(sessions, CONCURRENCY, async (sessionId) => {
    const reviewsDir = join(sessionsPath, sessionId, "telemetry", "reviews");
    let files: string[] | null = null;
    // ABSENT IS ENUMERATED. A session with no reviews directory demonstrably
    // holds no artifacts, which is a determinate empty file set; only a read
    // that FAILED leaves the set unknown. Deriving this from `files !== null`
    // collapsed the two and reported a confirmed-empty copy as unread, which is
    // the same conflation one layer up.
    let enumerated = true;
    try {
      files = await readdir(reviewsDir);
    } catch (e) {
      if (!isMissing(e)) {
        enumerated = false;
        // KNOWN SESSION: confined to a session whose existence is established.
        // Sibling sessions in this root stay authoritative.
        failures.push(fail(root, "known-session", reviewsDir, reasonOf(e), ["p1"], sessionId));
      }
      // ENOENT is confirmed absence: the session ran no reviews.
    }
    // RECORDED WHETHER OR NOT IT ENUMERATED. The session directory exists, so
    // this root demonstrably holds this session id, and that is what overlap
    // membership is about.
    const perFile = new Map<string, string | null>();
    held.set(sessionId, { enumerated, files: perFile });
    if (files !== null) {
      // Only a real listing counts as evidence that something was read. A
      // confirmed-absent directory must leave an otherwise untouched population
      // EMPTY rather than promoting it to COMPLETE.
      listedAny = true;
      for (const f of files.filter((f) => f.endsWith(".json"))) {
        const path = join(reviewsDir, f);
        // ENUMERATED FIRST, hash filled in after a successful read. A filename
        // that was OBSERVED in this root is evidence of sharing whether or not
        // its content could be read; entering it only on success let an
        // unreadable copy vanish from overlap accounting entirely, so a shared
        // filename could be reported as `no-shared-files`, or two copies as
        // matching while an uncomparable third was omitted.
        perFile.set(f, null);
        try {
          const parsed = parseArtifact(root, sessionId, f, JSON.parse(await readFile(path, "utf-8")));
          if (parsed === null) {
            failures.push(fail(root, "record", path, "missing required field", ["p1"], sessionId));
          } else {
            p1.push(parsed);
            perFile.set(f, parsed.contentHash);
          }
        } catch (e) {
          failures.push(fail(root, "record", path, reasonOf(e), ["p1"], sessionId));
        }
      }
    }

    const statePath = join(sessionsPath, sessionId, "state.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, "utf-8"));
      // VALIDATED, not asserted. A cast admits a string or an array as a
      // "readable record" whose every field then reads as absent, turning a
      // malformed file into evidence about the session it describes.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        failures.push(fail(root, "record", statePath, "state is not an object", ["p2"], sessionId));
      } else {
        const st = parsed as Record<string, unknown>;
        const rawLanding = st.landingDecision;
        const landingField: LandingField =
          // The schema's own default is `null`, so null is ABSENT: no decision
          // was recorded. Anything present that is not an object is MALFORMED.
          rawLanding === undefined || rawLanding === null
            ? "absent"
            : typeof rawLanding === "object" && !Array.isArray(rawLanding)
              ? "present"
              : "malformed";
        const ld = landingField === "present" ? (rawLanding as Record<string, unknown>) : null;
        const rawTicket = st.ticket;
        const ticket =
          typeof rawTicket === "object" && rawTicket !== null && !Array.isArray(rawTicket)
            ? (rawTicket as Record<string, unknown>)
            : null;
        p2.push({
          root,
          sessionId,
          landingField,
          // A present object whose `reason` is not a string is present with an
          // unreadable reason: `null` here, which `classifyLandingReason`
          // refuses, so it lands in `invalid` rather than being counted.
          landingReason: ld !== null && typeof ld.reason === "string" ? ld.reason : null,
          risk: ticket !== null && typeof ticket.risk === "string" ? ticket.risk : null,
          realizedRisk:
            ticket !== null && typeof ticket.realizedRisk === "string"
              ? ticket.realizedRisk
              : null,
        });
      }
    } catch (e) {
      if (!isMissing(e)) {
        // RECORD scope, and affecting P2 ONLY. P1 for this same session is
        // untouched, which is the point of classifying by affected population.
        failures.push(fail(root, "record", statePath, reasonOf(e), ["p2"], sessionId));
      }
    }
  });

  return {
    root,
    p1,
    p2,
    failures,
    p1State: stateFor(failures, "p1", p1.length > 0 || listedAny),
    p2State: stateFor(failures, "p2", p2.length > 0),
    sessions: held,
  };
}

/**
 * PARTIAL means some reads failed and some succeeded. UNAVAILABLE means nothing
 * was read at all. EMPTY means the scan succeeded and there was nothing there.
 */
function stateFor(
  failures: readonly ScanFailure[],
  population: PopulationId,
  anythingRead: boolean,
): ScanState {
  const relevant = failures.filter((f) => f.affects.includes(population));
  if (relevant.length === 0) return anythingRead ? "COMPLETE" : "EMPTY";
  return anythingRead ? "PARTIAL" : "UNAVAILABLE";
}

function overlapsOf(scans: readonly RootScan[]): SessionOverlap[] {
  const byId = new Map<string, RootScan[]>();
  for (const s of scans) {
    for (const sessionId of s.sessions.keys()) {
      const list = byId.get(sessionId);
      if (list) list.push(s);
      else byId.set(sessionId, [s]);
    }
  }
  const out: SessionOverlap[] = [];
  for (const [sessionId, roots] of byId) {
    if (roots.length < 2) continue;
    const holdings = roots.map((r) => r.sessions.get(sessionId)!);
    // A holder whose listing failed contributes NOTHING to the comparison and
    // must not be read as contributing an empty file set: it is why the
    // comparison below is incomplete rather than why it found nothing.
    const unreadListings = holdings.filter((h) => !h.enumerated).length;
    const maps = holdings.filter((h) => h.enumerated).map((h) => h.files);

    // EVERY FILENAME PRESENT IN AT LEAST TWO ROOTS, compared across the roots
    // that hold it. Intersecting across ALL roots was wrong for three or more:
    // a file in A and B but not C was dropped from the comparison entirely, so
    // A and B disagreeing about it could still be reported as matching, or even
    // as sharing no files at all.
    const names = new Set(maps.flatMap((m) => [...m.keys()]));
    let compared = 0;
    let differing = 0;
    let unknown = 0;
    for (const name of names) {
      const holders = maps.filter((m) => m.has(name));
      if (holders.length < 2) continue;
      compared += 1;
      const hashes = holders.map((m) => m.get(name) ?? null);
      const known = hashes.filter((h): h is string => h !== null);
      // A MISSING HASH IS NOT A DISAGREEMENT, but it does not ERASE one either.
      // With ["aaa", "bbb", null] the two known hashes already establish that
      // these copies differ; the third being unreadable cannot invalidate that
      // evidence. So the two are counted INDEPENDENTLY and a filename can
      // contribute to both.
      if (new Set(known).size > 1) differing += 1;
      if (known.length < hashes.length) unknown += 1;
    }

    // DIFFERING WINS. Established disagreement is a stronger fact than an
    // unread copy, so it survives the summary rather than being softened to
    // "unknown" by a missing hash somewhere else in the same session.
    //
    // `no-shared-files` comes LAST and only over complete listings, because it
    // is the one label here that asserts an absence. With a holder's filenames
    // unread, finding no shared name is a fact about the scan and not about the
    // copies, and the shared files could be exactly the ones not enumerated.
    const agreement: SessionOverlap["agreement"] =
      differing > 0 ? "differing"
        : unknown > 0 || unreadListings > 0 ? "unknown"
          : compared === 0 ? "no-shared-files"
            : "matching-stored-hashes";
    out.push({
      sessionId,
      roots: roots.map((r) => r.root),
      agreement,
      sharedFiles: compared,
      differingFiles: differing,
      unknownFiles: unknown,
      holdersWithUnreadListing: unreadListings,
    });
  }
  return out;
}

export async function scanRoots(roots: readonly string[]): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const scans = await mapLimit(roots, 4, scanRoot);
  const state: Record<string, ScanState> = {};
  const failures: ScanFailure[] = [];
  const p1: P1Artifact[] = [];
  const p2: P2Record[] = [];
  for (const s of scans) {
    state[`p1:${s.root}`] = s.p1State;
    state[`p2:${s.root}`] = s.p2State;
    failures.push(...s.failures);
    p1.push(...s.p1);
    p2.push(...s.p2);
  }
  return {
    report: {
      roots: [...roots],
      startedAt,
      finishedAt: new Date().toISOString(),
      // Sessions may be written while the scan runs. Stated rather than
      // pretended away, since every count here is as-of-scan.
      atomic: false,
      failures,
      readFailures: failures.length,
      state,
    },
    p1,
    p2,
    overlaps: overlapsOf(scans),
  };
}

/**
 * Discover roots under a fleet directory.
 *
 * ROOT-LEVEL RESULTS ARE AUTHORITATIVE and every root is labelled by PATH, never
 * by "project". 78 roots carry `.story/` and are not 78 projects: `agentkit-cloud`
 * is checked out 6 times and 30 roots have no git origin at all, so a cross-root
 * total is a SUM OF ROOT OBSERVATIONS that may include duplicates and is never
 * called unique fleet activity.
 */
export async function discoverFleetRoots(dir: string): Promise<{
  roots: string[];
  failures: ScanFailure[];
}> {
  const failures: ScanFailure[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    return {
      roots: [],
      failures: [fail(dir, "root-discovery", dir, reasonOf(e), ["p1", "p2"])],
    };
  }
  const roots: string[] = [];
  for (const name of entries) {
    const candidate = join(dir, name);
    try {
      // lstat, so a symlinked tree is not silently scanned twice under two
      // names and counted twice in a sum.
      const st = await lstat(candidate);
      if (!st.isDirectory()) continue;
      // `.story` MUST BE A DIRECTORY. A regular file with that name was
      // accepted as a root, and its sessions listing then failed with ENOTDIR
      // and was reported as an unavailable population -- making otherwise
      // complete fleet statistics conditional because of an entry that
      // determinately is not a project.
      if (!(await stat(join(candidate, ".story"))).isDirectory()) continue;
      roots.push(candidate);
    } catch (e) {
      if (!isMissing(e)) {
        failures.push(fail(candidate, "root-discovery", candidate, reasonOf(e), ["p1", "p2"]));
      }
    }
  }
  return { roots: roots.sort((a, b) => basename(a).localeCompare(basename(b))), failures };
}
