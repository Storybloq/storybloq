/**
 * Owner-liveness evidence for the session guard (T-450 step 2).
 *
 * THE ONLY PLACE the guard reaches the autonomous liveness runtime. That
 * boundary is deliberate and load-bearing in two directions:
 *
 *  - `session-scan.ts` stays a plain status path. It is the `storybloq status`
 *    DTO and documents that it does not import the autonomous runtime; making
 *    it perform process lookups would put a ps/proc call behind an ordinary
 *    status read.
 *  - `classifySessionGuard` stays PURE. It receives evidence and reads nothing,
 *    so it remains testable by construction rather than by fixture.
 *
 * WHY A WRAPPER AT ALL, rather than handing the classifier `readOwnerLiveness`
 * directly: the authorization handshake needs three values together, and no
 * existing surface carries them. `ActiveSessionSummary` has no `revision`, and
 * `OwnerLivenessVerdict` has neither the revision nor the digest. Capturing
 * them apart is what made an earlier draft's handshake unimplementable, so they
 * are captured here as one coherent triple.
 *
 * KEYED BY DIRECTORY, NOT BY ID. The guard supports duplicate embedded session
 * ids across different source directories and classifies BOTH the survivor and
 * the dropped participant. Liveness is a property of a DIRECTORY: the death
 * marker, the sidecar pid file and the telemetry tree all live in one. Applying
 * one directory's evidence to another manufactures a candidate out of a live
 * session, which is the exact false positive this ticket exists to prevent. The
 * map is therefore nested `sessionId -> sourceDir`, never a concatenated key:
 * both parts are values this module does not control, and a separator inside
 * one of them would address another session's slot.
 *
 * OBSERVATION ONLY at this step. Nothing here is wired into the guard yet and
 * no new verdict field is published; step 9 does that, once the handlers that
 * serve it exist.
 */
import { join, resolve } from "node:path";
import * as fs from "node:fs";
import {
  readOwnerLiveness,
  evidenceFingerprint,
  telemetryDirPath,
  OWNER_STALE_MS,
  type OwnerLivenessVerdict,
  type OwnableLivenessState,
  type SuccessorSource,
} from "../autonomous/liveness.js";
import { liveMcpServers } from "../autonomous/mcp-registry.js";
import { normalizeOwnerTask } from "../autonomous/client-profile.js";

/** One session's evidence, all three values from one coherent observation. */
export interface OwnerLivenessEvidence {
  readonly verdict: OwnerLivenessVerdict;
  /**
   * The revision the verdict was computed against, for the handshake's
   * compare-and-swap. Every read taken during the evaluation reported this
   * same value, or the session was omitted, so there is no question of which
   * read it belongs to.
   */
  readonly sessionRevision: number;
  /** Digest of the raw observations, for "did the picture change?". */
  readonly evidenceFingerprint: string;
}

/**
 * `sessionId -> sourceDir -> evidence`.
 *
 * A session missing from the map is the normal, expected answer for anything
 * that could not be observed. Callers must treat absence as "no evidence" and
 * fall through to their existing behavior, never as "no owner".
 */
export type OwnerLivenessMap = ReadonlyMap<string, ReadonlyMap<string, OwnerLivenessEvidence>>;

/** The fields one state read must yield. All six come from a single file. */
export interface ProbeSnapshot extends OwnableLivenessState {
  readonly revision: number;
}

/** What the probe needs from a scan row. Structurally a subset of `ActiveSessionSummary`. */
export interface ProbeTarget {
  readonly sessionId: string;
  readonly sourceDir: string;
}

export interface ProbeDeps {
  readonly now?: number;
  readonly staleThresholdMs?: number;
  /** Defaults to the project's server registry. Injected so tests need no live servers. */
  readonly readSuccessors?: SuccessorSource;
  /** Injected for tests. Returns null when the state cannot be read or parsed. */
  readonly readSessionState?: (sessionDir: string) => ProbeSnapshot | null;
}

/**
 * Resolve a scan row's directory INSIDE the sessions tree, or null.
 *
 * `sourceDir` is copied verbatim from a directory entry and never validated
 * (`ActiveSessionSummary.sourceDir` says so explicitly), so it reaches here as
 * an untrusted string. Two distinct failures matter: escaping the project, and
 * ALIASING, where two different strings address one directory and the guard
 * then sees two participants where one exists.
 *
 * Neither is decided lexically here, because lexical checks cannot see the
 * filesystem. `resolve` is pure string math: it does not follow symlinks, and
 * it does not know that macOS's default case-INSENSITIVE volume makes `Foo`
 * and `foo` the same directory under two different map keys. So the row must
 * name an entry the sessions directory actually reports, byte for byte, and
 * that entry must be a real directory rather than a link to one.
 */
function listSessionEntries(base: string): ReadonlySet<string> | null {
  try {
    return new Set(fs.readdirSync(base));
  } catch {
    // No sessions tree, or one we cannot enumerate. Nothing is observable, and
    // an empty result is exactly what "no evidence" means.
    return null;
  }
}

/** A validated directory and the identity it must still have when we publish. */
interface ValidatedDir {
  readonly path: string;
  readonly identity: string;
}

/**
 * `dev:ino` for a real directory, or null for anything else.
 *
 * `bigint` because an inode is not guaranteed to fit a double, and an identity
 * check that silently rounds is not an identity check.
 */
function directoryIdentity(path: string): string | null {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
  // lstat, NOT stat: a symlink must not resolve. A link pointing outside the
  // project would read state from anywhere on the machine, and one pointing at
  // a sibling session would file that session's evidence under a second key.
  if (!stat.isDirectory()) return null;
  return `${stat.dev}:${stat.ino}`;
}

function directChildDir(base: string, entries: ReadonlySet<string>, sourceDir: string): ValidatedDir | null {
  // Exact membership does all the work a pile of string rules only approximates.
  // `readdirSync` never returns "", ".", "..", an absolute path, a trailing
  // separator or a nested path, and it reports each name in its true case, so a
  // differently-cased row fails here even where the volume would have opened it.
  if (!entries.has(sourceDir)) return null;

  const path = join(base, sourceDir);
  const identity = directoryIdentity(path);
  return identity === null ? null : { path, identity };
}

/**
 * Read the six fields the predicate needs, or null.
 *
 * Null rather than a default-shaped object, deliberately. "No activity and no
 * owner identity" is a real and meaningful evidence combination, so
 * substituting it for an unreadable file would put a fabricated picture into
 * the map and let the guard act on a session it never actually observed.
 */
function defaultReadSessionState(sessionDir: string): ProbeSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(join(sessionDir, "state.json"), "utf-8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const revision = parsed.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  const lease = parsed.lease as { expiresAt?: string | null } | null | undefined;
  return {
    revision,
    lastGuideCall: typeof parsed.lastGuideCall === "string" ? parsed.lastGuideCall : null,
    mcpServerPid: typeof parsed.mcpServerPid === "number" ? parsed.mcpServerPid : null,
    mcpGuideCallAt: typeof parsed.mcpGuideCallAt === "string" ? parsed.mcpGuideCallAt : null,
    lease: lease && typeof lease === "object" ? { expiresAt: lease.expiresAt ?? null } : null,
    // Load-bearing since ruling C-2: succession is decided by whether the
    // OWNER's client is alive elsewhere. Omitting this yields
    // `owner-identity-unrecorded` and collapses every verdict to
    // `undetermined`, which is the feature quietly doing nothing.
    //
    // NORMALIZED, never cast. A cast would admit a truthy malformed record such
    // as `{}`, which is worse than admitting nothing: it compares unequal to
    // every live client, so the identity-bound check reads it as "the owner is
    // not among them" and reaches `gone-candidate` on an owner that was never
    // established. Malformed collapsing to null is the safe direction here,
    // since a null owner suppresses the verdict to `undetermined`.
    ownerTask: normalizeOwnerTask(parsed.ownerTask),
  };
}

/**
 * Probe each scan row against its own directory.
 *
 * Per-row failures are contained: an unreadable session is omitted and the rest
 * of the scan still returns. A scan that drops to empty on one bad entry is the
 * same silent fail-open the containment check above exists to prevent.
 */
export function probeOwnerLiveness(
  root: string,
  targets: readonly ProbeTarget[],
  deps: ProbeDeps = {},
): OwnerLivenessMap {
  const now = deps.now ?? Date.now();
  const staleThresholdMs = deps.staleThresholdMs ?? OWNER_STALE_MS;
  const readState = deps.readSessionState ?? defaultReadSessionState;
  const successors: SuccessorSource = deps.readSuccessors ?? (() => liveMcpServers(root));

  const base = resolve(join(root, ".story", "sessions"));
  const entries = listSessionEntries(base);
  const out = new Map<string, Map<string, OwnerLivenessEvidence>>();
  if (!entries) return out;

  for (const target of targets) {
    const validated = directChildDir(base, entries, target.sourceDir);
    if (!validated) continue;
    const dir = validated.path;

    // The provider performs a REAL read every time it is called, and
    // `readOwnerLiveness` calls it more than once on purpose: it re-reads the
    // owner's own state LAST, because the window between the first read and
    // the verdict is exactly where a live owner reappears. Caching one snapshot
    // would remove that refutation silently.
    //
    // Which leaves the coherence question. The re-read replaces the activity,
    // marker-validity and successor signals but carries the lease, death marker
    // and sidecar probe over from the FIRST read, so the shipped signal set can
    // straddle two reads and "the revision of the last read" would be a
    // revision the fingerprint does not entirely describe.
    //
    // Rather than guess which read to attribute, require there to be nothing to
    // attribute: every read must report the SAME revision. The revision is the
    // session's write counter, so one value across all reads means every read
    // saw one state and the triple describes one observation by construction.
    // A row whose revision moved mid-evaluation is not evidence of anything --
    // the picture changed while we were looking at it -- and is omitted.
    let failed = false;
    let incoherent = false;
    let revision: number | null = null;
    const provider = (): OwnableLivenessState => {
      const snapshot = readState(dir);
      if (!snapshot) {
        // A later read failing is not a milder problem than the first one
        // failing. Returning a default-shaped state here would let the
        // predicate decide against fabricated absent fields and then publish
        // the answer under the revision of a read that DID succeed.
        failed = true;
        return {};
      }
      if (revision === null) revision = snapshot.revision;
      else if (revision !== snapshot.revision) incoherent = true;
      return snapshot;
    };

    let verdict: OwnerLivenessVerdict;
    try {
      verdict = readOwnerLiveness(dir, provider, now, staleThresholdMs, successors);
    } catch {
      // Evidence gathering must never take the guard down with it. A session
      // that threw is a session with no evidence, which is exactly what
      // omission means, and the rest of the scan still returns.
      continue;
    }
    const sessionRevision = revision;
    if (failed || incoherent || sessionRevision === null) continue;

    // The directory we validated must still be the directory we read from.
    //
    // Membership and `lstat` answer a question about the moment they ran, and
    // every read since then followed a PATH. A session directory removed and
    // recreated in between (a concurrent cleanup, a session restarted under a
    // reused name) leaves those reads describing a different directory, and
    // publishing that under this row's key attributes one session's evidence
    // to another. Re-checking `dev:ino` at the end brackets every read.
    //
    // What this is: containment against concurrent recreation, in the same
    // shape as the revision rule above -- prove the observation was of one
    // thing, or omit it. What it is not: a defence against an adversary with
    // write access to `.story/`, who does not need a race at all, having the
    // state file itself. Closing that would take no-follow reads through an
    // open directory handle and is not what this guard is for.
    if (directoryIdentity(dir) !== validated.identity) continue;

    let inner = out.get(target.sessionId);
    if (!inner) {
      inner = new Map<string, OwnerLivenessEvidence>();
      out.set(target.sessionId, inner);
    }
    inner.set(target.sourceDir, {
      verdict,
      sessionRevision,
      evidenceFingerprint: evidenceFingerprint(verdict.signals),
    });
  }

  return out;
}

/** Re-exported so callers need not reach past this boundary for the tree path. */
export { telemetryDirPath };
