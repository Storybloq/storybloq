/**
 * T-477: the landings feed (plan section 4) -- read-time derivation of which
 * commits touched which tickets/issues, and their review coverage.
 *
 * Bounded execution: exactly one `git log`, one `rev-parse
 * --show-object-format`, and (only when `--since` is given) one `rev-parse
 * --verify` subprocess call per run -- zero per-token or per-commit
 * subprocesses. `%P`/`%T` come straight out of the single `git log` call, so
 * a commit's first-parent sha and tree id never need a second git
 * invocation.
 */

import { execFileSync } from "node:child_process";
import { CROCKFORD_CLASS } from "../models/types.js";
import { capString } from "../presence/redaction.js";
import { sanitizeDisplayText } from "./display-text.js";
import {
  computeReviewCoverage,
  computeCommitSummary,
  isTicketShapedRef,
  isIssueShapedRef,
  type ReviewCoverage,
  type CommitSummary,
} from "./review-coverage.js";
import { scanGateAcksOnce, unattributedWarningsFromScan, type TicketRefResolver } from "./gate-ack-loader.js";
import type { ProjectState } from "./project-state.js";

const GIT_TIMEOUT_MS = 10_000;
/** Sanitized for display, per 3.3's redaction note. */
const MAX_GIT_ERROR_BYTES = 500;
const MAX_SUBJECT_BYTES = 500;

export interface LandingRef {
  readonly ref: string; // canonical id, resolved via ProjectState
  readonly source: "subject-ref" | "resolution-sha";
  readonly crossConfirmed: boolean;
  readonly coverage: ReviewCoverage;
}

export interface UnresolvedResolutionSha {
  readonly issueRef: string;
  readonly token: string;
  readonly reason: "ambiguous-prefix" | "unresolved";
}

export interface Landing {
  readonly sha: string;
  readonly subject: string;
  readonly authoredAt: string;
  readonly refs: readonly LandingRef[];
  /** SUBJECT tokens (this commit's own) that looked ref-shaped but did not resolve. */
  readonly unresolvedTokens: readonly string[];
  readonly summary: CommitSummary;
}

export type LandingsResult =
  | {
      readonly status: "ok";
      readonly objectFormat: "sha1" | "sha256";
      readonly landings: readonly Landing[];
      /** Sanitized text of every gate-ack warning whose ticket could not be determined -- see review-coverage.ts's doctrine. */
      readonly unattributedGateAckWarnings: readonly string[];
      /**
       * A bad resolution-text sha candidate is an ISSUE-level diagnostic
       * (which issue's `resolution` field named it, and why it did not
       * resolve to a commit in this run) -- not a per-commit one, since by
       * definition an unresolved sha has no commit in this run to attach to.
       * Implementation decision (not in the ratified plan's literal type
       * shape, which nested this inside `Landing`): surfaced once at the
       * top level instead, the same way `unattributedGateAckWarnings` is,
       * rather than duplicated onto every landing or silently dropped.
       */
      readonly unresolvedResolutionShas: readonly UnresolvedResolutionSha[];
    }
  | { readonly status: "landings-unavailable"; readonly reason: string };

export interface LandingsOptions {
  readonly since?: string;
  readonly limit?: number;
}

/**
 * NUL, not a printable ASCII control character. A git commit subject can
 * legitimately contain ANY byte a human or script can type -- verified
 * empirically: `git commit` happily stores a literal 0x1f (unit separator)
 * byte in a subject and `%s` echoes it back unchanged, so a delimiter built
 * from a printable control character is not actually safe against a crafted
 * or coincidental subject (it would silently truncate or misalign that one
 * commit's fields). NUL is the one byte git itself refuses to store in a
 * commit message ("a NUL byte in commit log message not allowed", also
 * verified empirically), which is what makes it safe as BOTH the field
 * separator inside `--format` and, via `-z` below, the per-commit record
 * terminator -- no separate RECORD_SEP is needed.
 *
 * `LOG_FORMAT` below uses git's OWN `%x00` escape (four plain ASCII
 * characters in the argv string) rather than an interpolated literal `\0`
 * character: `execFileSync` throws synchronously on any argv string
 * containing an embedded NUL byte (verified empirically -- Node refuses to
 * exec a process with a NUL in one of its arguments, which is a real syscall
 * constraint, not a Node quirk), so the delimiter can only become a real NUL
 * byte in git's OWN stdout, which is exactly what `%x00` does at runtime. The
 * `FIELD_SEP` constant below is for splitting THAT output text (a real NUL
 * byte received back from a child process's stdout is fine to hold in a JS
 * string) -- it must never be interpolated into an argv string again.
 */
const FIELD_SEP = "\x00";
const LOG_FORMAT = "%H%x00%P%x00%T%x00%aI%x00%s";
const FIELDS_PER_RECORD = 5;

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

function sanitizeGitError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return capString(text, MAX_GIT_ERROR_BYTES) ?? "unknown git error";
}

/**
 * A commit subject (and any substring pulled from one, like a ref-shaped
 * token) is repository-controlled, untrusted text -- the same threat class
 * `sanitizeDisplayText` exists for elsewhere in this codebase
 * (gate-ack-loader.ts's filenames, session-guard's rendering rule): it could
 * carry a raw ANSI/OSC terminal escape sequence that a `--format md` render
 * would pass straight to a terminal. Sanitize FIRST, then cap to THIS file's
 * own byte budget -- `sanitizeDisplayText`'s own length cap
 * (`MAX_DISPLAY_LENGTH`) is a CHARACTER count for a display label, a
 * different unit than `MAX_SUBJECT_BYTES`, so it is passed a cap large
 * enough to never fire here; `capString`'s BYTE cap is the real limit,
 * applied second, matching this file's existing bound.
 */
function sanitizeGitText(value: string): string {
  return capString(sanitizeDisplayText(value, Number.MAX_SAFE_INTEGER), MAX_SUBJECT_BYTES) ?? "";
}

interface RawCommit {
  readonly sha: string;
  readonly parentSha: string | null;
  readonly treeId: string;
  readonly authoredAt: string;
  readonly subject: string;
}

/**
 * `-z` (passed alongside `LOG_FORMAT` at the call site) terminates each
 * commit's formatted output with an extra NUL in place of the usual
 * newline-based separation, so the raw output is just `FIELDS_PER_RECORD`
 * NUL-separated tokens per commit, back to back, with one trailing empty
 * token after the very last record (verified empirically) -- not a
 * newline-joined block of lines.
 */
function parseLog(text: string): RawCommit[] {
  const tokens = text.split(FIELD_SEP);
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

  const out: RawCommit[] = [];
  for (let i = 0; i + FIELDS_PER_RECORD <= tokens.length; i += FIELDS_PER_RECORD) {
    const [sha, parents, treeId, authoredAt, subject] = tokens.slice(i, i + FIELDS_PER_RECORD);
    if (!sha || !treeId || !authoredAt) continue;
    const firstParent = parents ? parents.trim().split(/\s+/)[0] : "";
    out.push({
      sha: sha.trim(),
      parentSha: firstParent ? firstParent : null,
      treeId: treeId.trim(),
      authoredAt: authoredAt.trim(),
      subject: (subject ?? "").trim(),
    });
  }
  return out;
}

/** Object-format-aware hex-sha regex, full length only (no `g` flag -- callers construct their own global copy when scanning). */
function fullShaPattern(hexLength: number): RegExp {
  return new RegExp(`^[0-9a-f]{${hexLength}}$`);
}

/** Word-boundary, non-anchored: finds ticket/issue-shaped tokens anywhere in free text. */
const REF_TOKEN_RE = new RegExp(
  `\\b(?:T-\\d+[a-z]?|t-${CROCKFORD_CLASS}{16}|ISS-\\d+|i-${CROCKFORD_CLASS}{16})\\b`,
  "g",
);

function extractRefTokens(subject: string): string[] {
  const matches = subject.match(REF_TOKEN_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Hex runs of any length >= 7 (git's own minimum unambiguous abbreviation) up
 * to and including full length. Case-insensitive at the pattern -- a
 * `resolution` field is free-form prose someone typed by hand, unlike `%H`'s
 * own always-lowercase output, so an uppercase or mixed-case sha must still
 * be found here; the caller's `.toLowerCase()` normalizes it afterward.
 */
function hexTokenPattern(maxHexLength: number): RegExp {
  return new RegExp(`\\b[0-9a-fA-F]{7,${maxHexLength}}\\b`, "g");
}

interface ResolvedToken {
  readonly ref: string; // canonical id
}

function resolveSubjectToken(state: ProjectState, token: string): ResolvedToken | "unresolved" {
  if (isTicketShapedRef(token)) {
    const r = state.resolveTicketRef(token);
    return r.kind === "found" ? { ref: r.item.id } : "unresolved";
  }
  if (isIssueShapedRef(token)) {
    const r = state.resolveIssueRef(token);
    return r.kind === "found" ? { ref: r.item.id } : "unresolved";
  }
  return "unresolved";
}

/**
 * Builds the alias-set resolver `computeReviewCoverage`/`ticketAcksFromScan`
 * need for gate-ack attribution (T-477 round-4 cap escalation, acceptor's
 * ruling): `ProjectState.resolveTicketRef` already resolves a ref against a
 * ticket's canonical id, its current display id, AND its previous display
 * ids in one call, which is exactly the alias set a corrupt ack's raw
 * `ticketRef` could legitimately be spelled with in this permanently-mixed
 * ledger.
 */
function makeTicketRefResolver(state: ProjectState): TicketRefResolver {
  return (raw) => {
    const r = state.resolveTicketRef(raw);
    return r.kind === "found" ? r.item.id : null;
  };
}

/**
 * Assembles the full landings feed for the given range. `root` is used both
 * for git subprocess calls and for `computeReviewCoverage`'s gate-ack
 * lookups (they read the SAME `.story/arrangement-acks/` directory this
 * project's git history lives alongside).
 */
export function buildLandings(root: string, state: ProjectState, options: LandingsOptions = {}): LandingsResult {
  let objectFormatRaw: string;
  try {
    objectFormatRaw = runGit(root, ["rev-parse", "--show-object-format"]).trim();
  } catch (err) {
    return { status: "landings-unavailable", reason: `Cannot determine git object format: ${sanitizeGitError(err)}` };
  }
  const objectFormat: "sha1" | "sha256" = objectFormatRaw === "sha256" ? "sha256" : "sha1";
  const hexLength = objectFormat === "sha256" ? 64 : 40;

  // Git's own `--max-count` treats a negative value as UNLIMITED (verified
  // empirically, not assumed), which would silently defeat the 200-commit
  // default bound this feature is documented as never exceeding; a
  // non-integer value instead reaches git as a raw, uninformative CLI error.
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit > 0)) {
    return { status: "landings-unavailable", reason: `--limit must be a positive integer, got ${options.limit}` };
  }

  if (options.since) {
    try {
      runGit(root, ["rev-parse", "--verify", "--end-of-options", `${options.since}^{commit}`]);
    } catch (err) {
      return { status: "landings-unavailable", reason: `Cannot resolve --since ref "${options.since}": ${sanitizeGitError(err)}` };
    }
  }

  const logArgs = options.since
    ? ["log", `${options.since}..HEAD`, "-z", `--format=${LOG_FORMAT}`]
    : ["log", `--max-count=${options.limit ?? 200}`, "-z", `--format=${LOG_FORMAT}`, "HEAD"];
  if (options.since && options.limit) logArgs.splice(1, 0, `--max-count=${options.limit}`);

  let rawLog: string;
  try {
    rawLog = runGit(root, logArgs);
  } catch (err) {
    return { status: "landings-unavailable", reason: `Cannot read git log: ${sanitizeGitError(err)}` };
  }

  const commits = parseLog(rawLog);
  const shaSet = new Set(commits.map((c) => c.sha));
  const isFullSha = fullShaPattern(hexLength);

  // ONE run-level `.story/arrangement-acks/` scan, reused for BOTH the
  // corruption check below AND every ref's `computeReviewCoverage` call --
  // never recomputed per commit or per ref (see review-coverage.ts's doc
  // comment on why a per-ref rescan would be both wasteful and pointless).
  const gateAckScan = scanGateAcksOnce(root);
  const unattributedGateAckWarningsRaw = unattributedWarningsFromScan(gateAckScan);
  const runHasUnattributedCorruption = unattributedGateAckWarningsRaw.length > 0;
  const unattributedGateAckWarnings = unattributedGateAckWarningsRaw
    .map((w) => capString(w, MAX_GIT_ERROR_BYTES))
    .filter((w): w is string => w !== null);

  // Pass 1: subject-ref discovery, per commit.
  const subjectRefsByCommit = new Map<string, Set<string>>();
  const unresolvedTokensByCommit = new Map<string, string[]>();
  for (const c of commits) {
    const tokens = extractRefTokens(c.subject);
    const resolved = new Set<string>();
    const unresolved: string[] = [];
    for (const token of tokens) {
      const r = resolveSubjectToken(state, token);
      if (r === "unresolved") unresolved.push(token);
      else resolved.add(r.ref);
    }
    subjectRefsByCommit.set(c.sha, resolved);
    unresolvedTokensByCommit.set(c.sha, unresolved);
  }

  // Pass 2: resolution-sha discovery -- scan every issue's own `resolution`
  // text for sha-shaped tokens, cross-referenced against THIS run's commit set.
  const resolutionRefsByCommit = new Map<string, Set<string>>();
  const unresolvedResolutionShasByIssue = new Map<string, UnresolvedResolutionSha[]>();
  for (const issue of state.issues) {
    const resolution = (issue as { resolution?: string | null }).resolution;
    if (!resolution) continue;
    const matches = resolution.match(hexTokenPattern(hexLength)) ?? [];
    for (const raw of matches) {
      const token = raw.toLowerCase();
      if (!isFullSha.test(token)) {
        // Shorter than full length: an ambiguous abbreviation. Never
        // guessed -- treated as unresolved regardless of what it might
        // prefix-match, per the plan's explicit "never guessed" rule.
        addUnresolvedResolutionSha(unresolvedResolutionShasByIssue, issue.id, token, "ambiguous-prefix");
        continue;
      }
      if (!shaSet.has(token)) {
        addUnresolvedResolutionSha(unresolvedResolutionShasByIssue, issue.id, token, "unresolved");
        continue;
      }
      const set = resolutionRefsByCommit.get(token) ?? new Set<string>();
      set.add(issue.id);
      resolutionRefsByCommit.set(token, set);
    }
  }

  const resolveTicketRefAlias = makeTicketRefResolver(state);

  // Assemble: union subject-refs and resolution-refs per commit, marking
  // crossConfirmed when a ref was found by BOTH mechanisms for the SAME commit.
  const landings: Landing[] = commits.map((c) => {
    const subjectRefs = subjectRefsByCommit.get(c.sha) ?? new Set<string>();
    const resolutionRefs = resolutionRefsByCommit.get(c.sha) ?? new Set<string>();
    const allRefs = new Set<string>([...subjectRefs, ...resolutionRefs]);

    const topology = { parentSha: c.parentSha, treeId: objectFormat === "sha256" ? null : c.treeId };
    const refs: LandingRef[] = [...allRefs].sort().map((ref) => {
      const inSubject = subjectRefs.has(ref);
      const inResolution = resolutionRefs.has(ref);
      const source: LandingRef["source"] = inResolution && !inSubject ? "resolution-sha" : "subject-ref";
      const coverage = computeReviewCoverage(root, ref, topology, runHasUnattributedCorruption, gateAckScan, resolveTicketRefAlias);
      return { ref, source, crossConfirmed: inSubject && inResolution, coverage };
    });

    return {
      sha: c.sha,
      subject: sanitizeGitText(c.subject),
      authoredAt: c.authoredAt,
      refs,
      // Ref-shaped tokens are already alnum/hyphen-constrained by REF_TOKEN_RE
      // (no control character can match it), so sanitizing here is pure
      // defense-in-depth against a future loosening of that pattern, not a
      // fix for a reachable case today.
      unresolvedTokens: (unresolvedTokensByCommit.get(c.sha) ?? []).map((t) => sanitizeGitText(t)),
      summary: computeCommitSummary(refs.map((r) => r.coverage)),
    };
  });

  return {
    status: "ok",
    objectFormat,
    landings,
    unattributedGateAckWarnings,
    unresolvedResolutionShas: [...unresolvedResolutionShasByIssue.values()].flat(),
  };
}

function addUnresolvedResolutionSha(
  map: Map<string, UnresolvedResolutionSha[]>,
  issueRef: string,
  token: string,
  reason: UnresolvedResolutionSha["reason"],
): void {
  const list = map.get(issueRef) ?? [];
  list.push({ issueRef, token: capString(token, MAX_SUBJECT_BYTES) ?? token, reason });
  map.set(issueRef, list);
}
