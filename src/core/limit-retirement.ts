/**
 * T-534: retirement of the T-424 usage-limit auto-resume. Claude Code now
 * continues at a usage limit on its own, so the StopFailure hook, the
 * SessionStart "resume" group, the waker and the global limit artifacts are
 * removed from installs that carried them.
 *
 * This module holds the decisions: which hook rows are ours, what a global
 * config looks like without its `limitResume` member, and whether a directory
 * tree is safe to delete. Every function here either is pure or touches only
 * the paths it is handed, and each refuses rather than guesses.
 */

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedFileDetailed } from "./bounded-read.js";
import { resolveSymlinkTarget } from "./symlink-write.js";
import { withSettingsWriteLock } from "./settings-write-lock.js";
import { captureProcessSignatureSync, inspectProcessIdentitySync, type ProcessIdentity } from "./process-identity.js";
import { hasArgvSignature, probeArgvSignature, safeUnlinkLock } from "../autonomous/liveness.js";
import { acquireProjectLockAsync, releaseProjectLock, verifyProjectLockOwnership, type ProjectLockHandle } from "./project-lock.js";
import {
  defaultSettingsPath,
  SESSIONSTART_SUBCOMMAND,
  STORYBLOQ_LEGACY_BASENAMES,
  parseHookCommand,
} from "./hook-migration.js";

/** The retired StopFailure hook's subcommand (the `session limit-stop` tombstone). */
export const LIMITSTOP_SUBCOMMAND = "session limit-stop";
/** The retired second SessionStart group's matcher (same resume-prompt command as "compact"). */
export const LIMIT_SESSIONSTART_MATCHER = "resume";

// ---------------------------------------------------------------------------
// Wake child identity (moved from the deleted autonomous/wake-claim.ts)
// ---------------------------------------------------------------------------

/** Attempt-specific argv sentinel, embedded in the wake child's prompt. */
export function wakeAttemptSentinel(attemptId: string): string {
  return `[storybloq-wake ${attemptId}]`;
}

/**
 * Full identity of a wake child: the resume session UUID PLUS the
 * attempt-specific sentinel embedded in its prompt argv. An interactive
 * `claude --resume <id>` shares the UUID but never the attempt sentinel, so
 * it can never be matched (or signalled) as the wake child.
 */
export function wakeChildMarkers(clientTaskId: string, attemptId: string): string[] {
  return [clientTaskId, wakeAttemptSentinel(attemptId)];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function isOurCommand(command: unknown, subcommand: string): boolean {
  if (typeof command !== "string") return false;
  const parsed = parseHookCommand(command);
  if (!parsed || !STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename)) return false;
  return parsed.rest.split(/\s+/).join(" ") === subcommand;
}

function hookCommand(entry: unknown): unknown {
  return typeof entry === "object" && entry !== null ? (entry as { command?: unknown }).command : undefined;
}

export interface HookRetirement {
  /** The settings object with the limit rows removed; the input is never mutated. */
  readonly settings: Record<string, unknown>;
  readonly removedEntries: number;
  readonly removedGroups: number;
}

/**
 * Removes the two hook rows the limit resume installed:
 * - every `session limit-stop` entry under a Storybloq basename (legacy
 *   `claudestory` included), whichever event and group carries it;
 * - Storybloq `session resume-prompt` entries in a SessionStart group whose
 *   matcher is exactly "resume". Broader groups (the compact group and the
 *   `startup|resume|clear|compact` group) are never touched.
 * Groups and events left empty by a removal are dropped. Anything that is not
 * the shape Claude Code writes is left exactly as found.
 */
export function retireLimitHooks(settings: Record<string, unknown>): HookRetirement {
  const next = structuredClone(settings);
  const hooks = next.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return { settings: next, removedEntries: 0, removedGroups: 0 };
  }
  const events = hooks as Record<string, unknown>;
  let removedEntries = 0;
  let removedGroups = 0;
  for (const event of Object.keys(events)) {
    const groups = events[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    let touched = false;
    for (const group of groups) {
      if (typeof group !== "object" || group === null || !Array.isArray((group as { hooks?: unknown }).hooks)) {
        kept.push(group);
        continue;
      }
      const g = group as { matcher?: unknown; hooks: unknown[] };
      const exactResume = event === "SessionStart" && g.matcher === LIMIT_SESSIONSTART_MATCHER;
      const entries = g.hooks.filter((entry) => {
        const command = hookCommand(entry);
        return !(isOurCommand(command, LIMITSTOP_SUBCOMMAND) || (exactResume && isOurCommand(command, SESSIONSTART_SUBCOMMAND)));
      });
      const removed = g.hooks.length - entries.length;
      if (removed === 0) {
        kept.push(group);
        continue;
      }
      touched = true;
      removedEntries += removed;
      if (entries.length === 0) {
        removedGroups += 1;
        continue;
      }
      kept.push({ ...g, hooks: entries });
    }
    if (!touched) continue;
    if (kept.length === 0) delete events[event];
    else events[event] = kept;
  }
  return { settings: next, removedEntries, removedGroups };
}

// ---------------------------------------------------------------------------
// Global config member
// ---------------------------------------------------------------------------

export type ConfigMemberRemoval =
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly text: string }
  | { readonly kind: "malformed" };

/**
 * Drops the `limitResume` member of the global config and keeps every other
 * member as it was. A config holding nothing else becomes `{}`, never a
 * deleted file. Anything that is not a JSON object is reported, not rewritten.
 */
export function removeLimitResumeMember(text: string): ConfigMemberRemoval {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "malformed" };
  if (!Object.prototype.hasOwnProperty.call(parsed, "limitResume")) return { kind: "unchanged" };
  const { limitResume: _dropped, ...rest } = parsed as Record<string, unknown>;
  return { kind: "changed", text: JSON.stringify(rest, null, 2) + "\n" };
}

// ---------------------------------------------------------------------------
// Artifact removal
// ---------------------------------------------------------------------------

export interface InspectedNode {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly directory: boolean;
}

export type TreeInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly nodes: readonly InspectedNode[] }
  | { readonly kind: "refused"; readonly reasons: readonly string[] };

function ourUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Walks `root` with lstat and admits only regular files and directories owned
 * by this uid. A symlink, a special file or a foreign owner anywhere in the
 * tree refuses the whole tree: nothing is deleted from a tree that was not
 * fully checked. Nodes are returned deepest first, the order they are removed in.
 */
export function inspectTreeForRemoval(root: string): TreeInspection {
  const uid = ourUid();
  const nodes: InspectedNode[] = [];
  const reasons: string[] = [];
  const visit = (path: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path);
    } catch (err) {
      reasons.push(`${path}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
      return;
    }
    if (st.isSymbolicLink()) {
      reasons.push(`${path}: symlink`);
      return;
    }
    if (!st.isFile() && !st.isDirectory()) {
      reasons.push(`${path}: not a regular file or directory`);
      return;
    }
    if (uid !== null && st.uid !== uid) {
      reasons.push(`${path}: owned by uid ${st.uid}`);
      return;
    }
    if (st.isDirectory()) {
      let children: string[];
      try {
        children = fs.readdirSync(path);
      } catch (err) {
        reasons.push(`${path}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
        return;
      }
      for (const child of children) visit(join(path, child));
    }
    nodes.push({ path, dev: st.dev, ino: st.ino, directory: st.isDirectory() });
  };
  try {
    fs.lstatSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "refused", reasons: [`${root}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`] };
  }
  visit(root);
  return reasons.length > 0 ? { kind: "refused", reasons } : { kind: "ok", nodes };
}

export type TreeRemoval =
  | { readonly kind: "removed"; readonly count: number }
  | { readonly kind: "aborted"; readonly reason: string; readonly removed: number };

/**
 * Removes inspected nodes deepest first. Each node is lstat'ed again just
 * before its unlink or rmdir and must still be the same dev/ino, kind and
 * owner; a node swapped since inspection aborts the removal where it stands.
 * Directories go with a non-recursive rmdir, so an entry added after the
 * inspection makes the removal fail (ENOTEMPTY) instead of being swept.
 * `parentGuard`, when given, runs before the first removal and again before
 * the last one (the root itself); a non-null answer aborts with that reason.
 */
export function removeInspectedTree(
  nodes: readonly InspectedNode[],
  parentGuard?: () => string | null,
): TreeRemoval {
  let removed = 0;
  const uid = ourUid();
  for (const [index, node] of nodes.entries()) {
    if (parentGuard && (index === 0 || index === nodes.length - 1)) {
      const refusal = parentGuard();
      if (refusal !== null) return { kind: "aborted", reason: refusal, removed };
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(node.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { kind: "aborted", reason: `${node.path}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`, removed };
    }
    if (st.dev !== node.dev || st.ino !== node.ino || st.isDirectory() !== node.directory || st.isSymbolicLink() || (uid !== null && st.uid !== uid)) {
      return { kind: "aborted", reason: `${node.path}: changed since inspection`, removed };
    }
    try {
      if (node.directory) fs.rmdirSync(node.path);
      else fs.unlinkSync(node.path);
    } catch (err) {
      return { kind: "aborted", reason: `${node.path}: ${(err as NodeJS.ErrnoException).code ?? "unremovable"}`, removed };
    }
    removed += 1;
  }
  return { kind: "removed", count: removed };
}

// ---------------------------------------------------------------------------
// File rewrites
// ---------------------------------------------------------------------------

export type FileRewrite =
  | { readonly kind: "absent" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly removed: number }
  | { readonly kind: "refused"; readonly reason: string };

/** Test seam: runs after the first read and before the confirming re-read. */
export interface RewriteHooks {
  readonly beforeRecheck?: () => void;
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? String(err);
}

/**
 * Removes the limit hook rows from the user's Claude Code settings, holding
 * the lock every Storybloq settings writer takes. The destination is resolved
 * (a settings.json kept as a symlink stays one) and identified, the new copy
 * is prepared in a temp file beside it, and only then is everything checked
 * again: the link still resolves to the same file, that file is the same
 * inode with the same bytes, and the lock is still ours. The rename follows
 * the recheck synchronously. Any difference means someone else is editing the
 * file, so nothing is written.
 */
export async function retireSettingsHooks(
  path = defaultSettingsPath(),
  hooks: RewriteHooks & { readonly lockDeadlineMs?: number } = {},
): Promise<FileRewrite> {
  const busy: FileRewrite = {
    kind: "refused",
    reason: `${path}: another Storybloq settings writer holds the lock, or its destination cannot be resolved; left untouched`,
  };
  return withSettingsWriteLock(path, busy, (handle) => retireSettingsHooksLocked(path, handle, hooks), hooks.lockDeadlineMs);
}

async function retireSettingsHooksLocked(path: string, handle: ProjectLockHandle, hooks: RewriteHooks): Promise<FileRewrite> {
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(path);
  } catch (err) {
    return errorCode(err) === "ENOENT" ? { kind: "absent" } : { kind: "refused", reason: `${path}: ${errorCode(err)}` };
  }
  const viaLink = linkStat.isSymbolicLink();
  let destination: string;
  try {
    destination = viaLink ? await resolveSymlinkTarget(path) : path;
  } catch (err) {
    return { kind: "refused", reason: `${path}: symlink unresolvable (${errorCode(err)})` };
  }
  const identify = (): fs.Stats | string => {
    try {
      const st = fs.lstatSync(destination);
      return st.isFile() ? st : "not a regular file";
    } catch (err) {
      return errorCode(err);
    }
  };
  const before = identify();
  if (before === "ENOENT") return { kind: "absent" };
  if (typeof before === "string") return { kind: "refused", reason: `${destination}: ${before}` };
  const first = readBoundedFileDetailed(destination);
  if (first.kind === "absent") return { kind: "absent" };
  if (first.kind === "indeterminate") return { kind: "refused", reason: `${path}: ${first.reason}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return { kind: "refused", reason: `${path}: malformed JSON, left untouched` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "refused", reason: `${path}: not a JSON object, left untouched` };
  }
  const result = retireLimitHooks(parsed as Record<string, unknown>);
  if (result.removedEntries === 0) return { kind: "unchanged" };

  const tmp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(result.settings, null, 2) + "\n", { flag: "wx", mode: before.mode & 0o777 });
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    return { kind: "refused", reason: `${path}: write failed (${errorCode(err)})` };
  }
  hooks.beforeRecheck?.();
  // From here to the rename nothing yields to the event loop.
  const resolvesTo = (): string | null => {
    try {
      const st = fs.lstatSync(path);
      if (st.isSymbolicLink() !== viaLink) return null;
      return viaLink ? fs.realpathSync(path) : path;
    } catch {
      return null;
    }
  };
  const after = identify();
  const second = readBoundedFileDetailed(destination);
  const unchanged =
    resolvesTo() === destination &&
    typeof after !== "string" && after.dev === before.dev && after.ino === before.ino &&
    second.kind === "ok" && second.bytes.equals(first.bytes) &&
    verifyProjectLockOwnership(handle);
  if (!unchanged) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { kind: "refused", reason: `${path}: changed while being rewritten, left untouched` };
  }
  try {
    fs.renameSync(tmp, destination);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { kind: "refused", reason: `${path}: write failed (${errorCode(err)})` };
  }
  return { kind: "rewritten", removed: result.removedEntries };
}

/**
 * Removes the `limitResume` member from the global config.json. The file must
 * be a regular file owned by this uid (never followed through a symlink), is
 * re-read and re-identified just before the write, and is replaced by an
 * exclusive temp file renamed over it with the original permissions.
 */
export function retireGlobalConfigMember(path: string, hooks: RewriteHooks = {}): FileRewrite {
  const identify = (): fs.Stats | string => {
    try {
      const st = fs.lstatSync(path);
      if (st.isSymbolicLink()) return "symlink";
      if (!st.isFile()) return "not a regular file";
      const uid = ourUid();
      if (uid !== null && st.uid !== uid) return `owned by uid ${st.uid}`;
      return st;
    } catch (err) {
      return errorCode(err);
    }
  };
  const before = identify();
  if (before === "ENOENT") return { kind: "absent" };
  if (typeof before === "string") return { kind: "refused", reason: `${path}: ${before}` };
  const first = readBoundedFileDetailed(path);
  if (first.kind !== "ok") return { kind: "refused", reason: `${path}: ${first.kind === "absent" ? "vanished" : first.reason}` };
  const removal = removeLimitResumeMember(first.text);
  if (removal.kind === "malformed") return { kind: "refused", reason: `${path}: malformed JSON, left untouched` };
  if (removal.kind === "unchanged") return { kind: "unchanged" };
  hooks.beforeRecheck?.();
  const after = identify();
  const second = readBoundedFileDetailed(path);
  if (typeof after === "string" || after.dev !== before.dev || after.ino !== before.ino || second.kind !== "ok" || !second.bytes.equals(first.bytes)) {
    return { kind: "refused", reason: `${path}: changed while being rewritten, left untouched` };
  }
  const tmp = join(dirname(path), `.config.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, removal.text, { flag: "wx", mode: before.mode & 0o777 });
    fs.renameSync(tmp, path);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    return { kind: "refused", reason: `${path}: write failed (${errorCode(err)})` };
  }
  return { kind: "rewritten", removed: 1 };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type AttemptVerdict = "live" | "gone" | "preserve";

export interface AttemptClassification {
  readonly recordKey: string;
  /** The autonomous session the record belongs to, when it names one. */
  readonly sessionId: string | null;
  readonly attemptId: string | null;
  /** `child`: a spawned wake child (probed by argv markers); `claim`: a bare claim (probed by claimant identity). */
  readonly kind: "child" | "claim";
  readonly verdict: AttemptVerdict;
  readonly reason: string;
}

export interface ReferencedSession {
  readonly projectRoot: string;
  readonly sessionId: string;
}

export type LedgerReading =
  | { readonly kind: "malformed"; readonly reason: string }
  | {
      readonly kind: "ok";
      readonly attempts: readonly AttemptClassification[];
      readonly sessions: readonly ReferencedSession[];
      /** True when any attempt is live or could not be classified: the ledger stays and no marker is written. */
      readonly blocking: boolean;
    };

export interface AttemptProbes {
  readonly probeChild: (pid: number, markers: readonly string[]) => "match" | "absent" | "unknown";
  readonly inspectClaimant: (pid: number, signature: string | null) => ProcessIdentity;
  /** Whether any process of ours carries every marker in its argv, pid unknown. */
  readonly scanForChild: (markers: readonly string[]) => "present" | "absent" | "unknown";
}

const SCAN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A process-table scan for a wake child whose pid was never persisted: the
 * retired waker spawned the child before it recorded the pid, so a dead waker
 * with a null childPid does not prove no child exists. Every process of this
 * uid is read in full (`-ww`, since the attempt sentinel sits at the end of a
 * long prompt); anything short of a complete read is "unknown", never
 * "absent".
 */
export function scanProcessesForMarkers(markers: readonly string[]): "present" | "absent" | "unknown" {
  if (markers.length === 0) return "unknown";
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid < 0) return "unknown";
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/bin/ps", ["-ww", "-axo", "uid=,command="], {
        encoding: "utf-8",
        timeout: 5000,
        maxBuffer: SCAN_MAX_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        const space = trimmed.indexOf(" ");
        if (space < 0) continue;
        if (Number(trimmed.slice(0, space)) !== uid) continue;
        const command = trimmed.slice(space + 1);
        if (markers.every((m) => command.includes(m))) return "present";
      }
      return "absent";
    }
    if (process.platform === "linux") {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^[0-9]+$/.test(entry)) continue;
        let command: string;
        try {
          if (fs.statSync(`/proc/${entry}`).uid !== uid) continue;
          command = fs.readFileSync(`/proc/${entry}/cmdline`).toString("utf-8").replace(/\0/g, " ");
        } catch (err) {
          // A process that exited mid-scan is gone; anything else is unreadable.
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ESRCH") continue;
          return "unknown";
        }
        if (markers.every((m) => command.includes(m))) return "present";
      }
      return "absent";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export const DEFAULT_ATTEMPT_PROBES: AttemptProbes = {
  probeChild: (pid, markers) => probeArgvSignature(pid, markers),
  inspectClaimant: (pid, signature) => inspectProcessIdentitySync(pid, signature),
  scanForChild: (markers) => scanProcessesForMarkers(markers),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Reads the retired ledger without its schema (the schema leaves with the
 * runtime) and classifies every in-flight attempt. A spawned wake child has
 * no persisted signature, so it is probed by the markers the waker put in its
 * argv; a claim that never spawned is judged by the identity of the waker that
 * made it. Nothing here signals anything: a live or unknown attempt only
 * holds the ledger in place for the next invocation.
 */
export function classifyLedger(text: string, probes: AttemptProbes = DEFAULT_ATTEMPT_PROBES): LedgerReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed", reason: "not JSON" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.records)) return { kind: "malformed", reason: "no records object" };
  const attempts: AttemptClassification[] = [];
  const sessions: ReferencedSession[] = [];
  for (const [recordKey, record] of Object.entries(parsed.records)) {
    if (!isRecord(record)) {
      attempts.push({ recordKey, sessionId: null, attemptId: null, kind: "claim", verdict: "preserve", reason: "record is not an object" });
      continue;
    }
    const sessionId = typeof record.storybloqSessionId === "string" ? record.storybloqSessionId : null;
    if (typeof record.projectRoot === "string" && typeof record.storybloqSessionId === "string") {
      sessions.push({ projectRoot: record.projectRoot, sessionId: record.storybloqSessionId });
    }
    const attempt = record.attempt;
    if (attempt === null || attempt === undefined) continue;
    if (!isRecord(attempt)) {
      attempts.push({ recordKey, sessionId, attemptId: null, kind: "claim", verdict: "preserve", reason: "attempt is not an object" });
      continue;
    }
    const attemptId = typeof attempt.id === "string" ? attempt.id : null;
    const childPid = attempt.childPid;
    if (childPid !== null && childPid !== undefined) {
      const pid = positiveInt(childPid);
      if (pid === null || attemptId === null || typeof record.clientTaskId !== "string") {
        attempts.push({ recordKey, sessionId, attemptId, kind: "child", verdict: "preserve", reason: "child cannot be identified" });
        continue;
      }
      const probe = probes.probeChild(pid, wakeChildMarkers(record.clientTaskId, attemptId));
      attempts.push({
        recordKey,
        sessionId,
        attemptId,
        kind: "child",
        verdict: probe === "match" ? "live" : probe === "absent" ? "gone" : "preserve",
        reason: `child ${pid}: ${probe}`,
      });
      continue;
    }
    const claimant = positiveInt(attempt.claimantPid);
    const signature = typeof attempt.claimantSignature === "string" ? attempt.claimantSignature : null;
    if (claimant === null) {
      attempts.push({ recordKey, sessionId, attemptId, kind: "claim", verdict: "preserve", reason: "claimant not recorded" });
      continue;
    }
    const identity = probes.inspectClaimant(claimant, signature);
    const claimantReason = `claimant ${claimant}: ${identity}${signature === null ? " (no signature)" : ""}`;
    if (identity !== "dead") {
      attempts.push({
        recordKey,
        sessionId,
        attemptId,
        kind: "claim",
        verdict: identity === "alive" ? "live" : "preserve",
        reason: claimantReason,
      });
      continue;
    }
    // A dead claimant is not proof the attempt never spawned: the waker
    // started the child before it persisted the pid. Gone only when a full
    // process scan finds no process carrying the attempt's markers.
    if (attemptId === null || typeof record.clientTaskId !== "string") {
      attempts.push({ recordKey, sessionId, attemptId, kind: "claim", verdict: "preserve", reason: `${claimantReason}; the child cannot be identified` });
      continue;
    }
    const scan = probes.scanForChild(wakeChildMarkers(record.clientTaskId, attemptId));
    attempts.push({
      recordKey,
      sessionId,
      attemptId,
      kind: "claim",
      verdict: scan === "absent" ? "gone" : scan === "present" ? "live" : "preserve",
      reason: `${claimantReason}; unrecorded child ${scan}`,
    });
  }
  return { kind: "ok", attempts, sessions, blocking: attempts.some((a) => a.verdict !== "gone") };
}

// ---------------------------------------------------------------------------
// Global artifacts
// ---------------------------------------------------------------------------

export const RETIREMENT_MARKER_BASENAME = ".limit-retired-v1";
export const RETIREMENT_LOCK_BASENAME = "limit-retirement.lock";
const WAKER_LOCK_BASENAME = "waker.lock";
const LEDGER_BASENAME = "limit-ledger.json";
const LEDGER_LOCK_BASENAME = "limit-ledger.lock";
const WAKE_CLAIMS_DIRNAME = "wake-claims";
const WAKER_LOCK_MAX_BYTES = 4_096;
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;

export type OwnedFileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly text: string; readonly dev: number; readonly ino: number }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Bounded read of a file that must be a regular file owned by this uid,
 * opened without following a symlink. The dev/ino it returns is what a later
 * unlink is checked against.
 */
export function readOwnedFileNoFollow(path: string, maxBytes: number): OwnedFileRead {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "refused", reason: `${path}: not a regular file` };
    const uid = ourUid();
    if (uid !== null && st.uid !== uid) return { kind: "refused", reason: `${path}: owned by uid ${st.uid}` };
    if (st.size > maxBytes) return { kind: "refused", reason: `${path}: larger than ${maxBytes} bytes` };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { kind: "ok", text: buf.subarray(0, read).toString("utf-8"), dev: st.dev, ino: st.ino };
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return { kind: "absent" };
    // O_NOFOLLOW on a symlink fails with ELOOP.
    return { kind: "refused", reason: `${path}: ${code === "ELOOP" ? "symlink" : code}` };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Unlinks `path` only if it is still the regular, owned, non-symlink file
 * first seen as dev/ino. Absent counts as done.
 */
export function unlinkIdentified(path: string, expected: { readonly dev: number; readonly ino: number } | null): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (err) {
    return errorCode(err) === "ENOENT" ? null : `${path}: ${errorCode(err)}`;
  }
  const uid = ourUid();
  if (st.isSymbolicLink() || !st.isFile() || (uid !== null && st.uid !== uid)) return `${path}: not an owned regular file`;
  if (expected !== null && (st.dev !== expected.dev || st.ino !== expected.ino)) return `${path}: changed since inspection`;
  try {
    fs.unlinkSync(path);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") return `${path}: ${errorCode(err)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ledger removal
// ---------------------------------------------------------------------------

export interface LedgerRemovalHooks {
  /** Test seam: runs after the ledger is unlinked, while the ledger lock is still held. */
  readonly afterLedgerUnlink?: () => void;
}

/**
 * The final ledger cleanup. It takes `limit-ledger.lock` with the retired
 * writers' own protocol (a hard-linked body naming pid, token and signature),
 * so any of them still running polls while it is held and fails the token
 * fence it checks before every rename. A live or unverifiable holder is never
 * stolen from: the step fails and the next command retries. Only a holder
 * whose process is provably gone is broken. Holding the lock, the ledger is
 * removed only if it is still the file classified earlier; the lock is then
 * released, and the ledger path is checked once more, because a writer that
 * passed its fence before the lock was taken can still rename afterwards.
 */
export function removeLedgerUnderLock(
  globalDir: string,
  classified: { readonly dev: number; readonly ino: number; readonly text: string } | null,
  hooks: LedgerRemovalHooks = {},
): string | null {
  const lockPath = join(globalDir, LEDGER_LOCK_BASENAME);
  const ledgerPath = join(globalDir, LEDGER_BASENAME);
  const existing = readOwnedFileNoFollow(lockPath, WAKER_LOCK_MAX_BYTES);
  if (existing.kind === "refused") return existing.reason;
  if (existing.kind === "ok") {
    let body: unknown;
    try {
      body = JSON.parse(existing.text);
    } catch {
      return `${lockPath}: unreadable holder, left in place`;
    }
    const pid = isRecord(body) ? positiveInt(body.pid) : null;
    const token = isRecord(body) && typeof body.token === "string" && body.token !== "" ? body.token : null;
    if (pid === null || token === null || !isRecord(body)) return `${lockPath}: no holder pid or token, left in place`;
    const signature = typeof body.processSignature === "string" ? body.processSignature : null;
    const identity = inspectProcessIdentitySync(pid, signature);
    if (identity !== "dead") {
      return `${lockPath}: held by ${identity === "alive" ? "a live" : "an unverifiable"} ledger writer (pid ${pid}), left in place`;
    }
    const broken = safeUnlinkLock(lockPath, existing.ino, token);
    if (!broken.unlinked) return `${lockPath}: stale holder could not be removed (${broken.reason ?? "unknown"})`;
  }

  const token = randomUUID();
  const now = Date.now();
  const tmp = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, token, acquiredAt: now, renewedAt: now, processSignature: captureProcessSignatureSync(process.pid) }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (err) {
    return `${lockPath}: could not prepare the lock (${errorCode(err)})`;
  }
  let inode: number;
  try {
    fs.linkSync(tmp, lockPath);
    inode = fs.statSync(tmp).ino;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return `${lockPath}: taken by another writer (${errorCode(err)}), retried on the next command`;
  }

  let problem: string | null = null;
  try {
    const current = readOwnedFileNoFollow(ledgerPath, LEDGER_MAX_BYTES);
    if (classified === null) {
      if (current.kind !== "absent") problem = `${ledgerPath}: appeared during retirement, left in place`;
    } else if (current.kind !== "ok" || current.dev !== classified.dev || current.ino !== classified.ino || current.text !== classified.text) {
      problem = `${ledgerPath}: changed during retirement, left in place`;
    } else {
      problem = unlinkIdentified(ledgerPath, classified);
      if (problem === null) hooks.afterLedgerUnlink?.();
    }
  } finally {
    const released = safeUnlinkLock(lockPath, inode, token);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (problem === null && !released.unlinked) problem = `${lockPath}: could not be released (${released.reason ?? "unknown"})`;
  }
  if (problem !== null) return problem;
  try {
    fs.lstatSync(ledgerPath);
    return `${ledgerPath}: rewritten by a retired ledger writer after removal, retried on the next command`;
  } catch (err) {
    return errorCode(err) === "ENOENT" ? null : `${ledgerPath}: ${errorCode(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Waker
// ---------------------------------------------------------------------------

export interface WakerStopDeps {
  readonly inspect: (pid: number, signature: string | null) => ProcessIdentity;
  /** Both waker markers present in the pid's argv. */
  readonly isWakerArgv: (pid: number) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export type WakerStop =
  | { readonly kind: "absent" }
  | { readonly kind: "not-running"; readonly dev: number; readonly ino: number }
  | { readonly kind: "stopped"; readonly dev: number; readonly ino: number; readonly killed: boolean }
  | { readonly kind: "refused"; readonly reason: string };

/** The retired waker's argv sentinel (waker.ts WAKER_ARGV_SENTINEL); kept here because waker.ts leaves in C3. */
const WAKER_ARGV_SENTINEL = "--sb-waker";
const WAKER_TERM_WAIT_MS = 5_000;
const WAKER_POLL_MS = 250;

export const DEFAULT_WAKER_STOP_DEPS: WakerStopDeps = {
  inspect: (pid, signature) => inspectProcessIdentitySync(pid, signature),
  isWakerArgv: (pid) => hasArgvSignature(pid, ["waker-run", WAKER_ARGV_SENTINEL]),
  signal: (pid, sig) => process.kill(pid, sig),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Stops the retired waker named by `waker.lock`. A pid is signalled only when
 * its identity is alive, its signature matches the lock and its argv carries
 * both waker markers; anything ambiguous is left alone and refused, so a
 * reused pid is never signalled.
 */
export async function stopRetiredWaker(lockPath: string, deps: WakerStopDeps = DEFAULT_WAKER_STOP_DEPS): Promise<WakerStop> {
  const read = readOwnedFileNoFollow(lockPath, WAKER_LOCK_MAX_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "refused") return read;
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return { kind: "refused", reason: `${lockPath}: unreadable holder, left in place` };
  }
  const pid = isRecord(body) ? positiveInt(body.pid) : null;
  if (pid === null || !isRecord(body)) return { kind: "refused", reason: `${lockPath}: no holder pid, left in place` };
  const signature = typeof body.processSignature === "string" ? body.processSignature : null;
  const file = { dev: read.dev, ino: read.ino };

  const first = deps.inspect(pid, signature);
  if (first === "dead") return { kind: "not-running", ...file };
  if (first === "unknown") return { kind: "refused", reason: `waker ${pid}: identity unverifiable, not signalled` };
  if (!deps.isWakerArgv(pid)) return { kind: "refused", reason: `waker ${pid}: argv is not the waker's, not signalled` };

  const waitGone = async (): Promise<ProcessIdentity> => {
    for (let waited = 0; waited < WAKER_TERM_WAIT_MS; waited += WAKER_POLL_MS) {
      await deps.sleep(WAKER_POLL_MS);
      const now = deps.inspect(pid, signature);
      if (now !== "alive") return now;
    }
    return "alive";
  };
  const send = (sig: NodeJS.Signals): string | null => {
    try {
      deps.signal(pid, sig);
      return null;
    } catch (err) {
      return errorCode(err) === "ESRCH" ? null : `waker ${pid}: ${sig} failed (${errorCode(err)})`;
    }
  };

  const termFailed = send("SIGTERM");
  if (termFailed !== null) return { kind: "refused", reason: termFailed };
  const afterTerm = await waitGone();
  if (afterTerm === "dead") return { kind: "stopped", ...file, killed: false };
  if (afterTerm === "unknown") return { kind: "refused", reason: `waker ${pid}: identity unverifiable after SIGTERM` };
  if (!deps.isWakerArgv(pid)) return { kind: "refused", reason: `waker ${pid}: argv changed after SIGTERM, not killed` };
  const killFailed = send("SIGKILL");
  if (killFailed !== null) return { kind: "refused", reason: killFailed };
  await deps.sleep(WAKER_POLL_MS);
  const afterKill = deps.inspect(pid, signature);
  if (afterKill === "dead") return { kind: "stopped", ...file, killed: true };
  return { kind: "refused", reason: `waker ${pid}: still ${afterKill} after SIGKILL` };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RetirementDeps {
  readonly globalDir: string;
  readonly settingsPath: string;
  readonly cliVersion: string;
  readonly probes: AttemptProbes;
  readonly waker: WakerStopDeps;
  /** Part B over the sessions the ledger references plus the current project's; returns what it skipped. */
  readonly normalizeSessions: (sessions: readonly ReferencedSession[]) => Promise<readonly string[]>;
  readonly lockDeadlineMs: number;
  readonly ledgerHooks?: LedgerRemovalHooks;
}

export type RetirementResult =
  | { readonly kind: "already" }
  | { readonly kind: "busy" }
  | { readonly kind: "retired"; readonly notes: readonly string[] }
  | { readonly kind: "incomplete"; readonly problems: readonly string[]; readonly notes: readonly string[] };

export function retirementMarkerPresent(globalDir: string): boolean {
  try {
    const st = fs.lstatSync(join(globalDir, RETIREMENT_MARKER_BASENAME));
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function writeMarker(globalDir: string, cliVersion: string): string | null {
  const path = join(globalDir, RETIREMENT_MARKER_BASENAME);
  const tmp = join(globalDir, `${RETIREMENT_MARKER_BASENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ cliVersion, retiredAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, path);
    return null;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    return `${path}: write failed (${errorCode(err)})`;
  }
}

function directoryIdentity(path: string): { dev: number; ino: number } | string {
  try {
    const st = fs.lstatSync(path);
    const uid = ourUid();
    if (st.isSymbolicLink() || !st.isDirectory()) return `${path}: not a real directory`;
    if (uid !== null && st.uid !== uid) return `${path}: owned by uid ${st.uid}`;
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    return `${path}: ${errorCode(err)}`;
  }
}

/**
 * The global half of the retirement, in the order the plan fixes: hooks,
 * waker, ledger attempts, sessions (best effort), artifacts, ledger last.
 * Serialised by a dedicated lock; a process that cannot take it skips and the
 * next invocation retries. The marker is written only when every step
 * succeeded or had nothing to do.
 */
export async function runLimitRetirement(deps: RetirementDeps): Promise<RetirementResult> {
  const { globalDir } = deps;
  if (retirementMarkerPresent(globalDir)) return { kind: "already" };
  let handle: ProjectLockHandle;
  try {
    handle = await acquireProjectLockAsync(join(globalDir, RETIREMENT_LOCK_BASENAME), { deadlineMs: deps.lockDeadlineMs });
  } catch {
    return { kind: "busy" };
  }
  try {
    if (retirementMarkerPresent(globalDir)) return { kind: "already" };
    const problems: string[] = [];
    const notes: string[] = [];

    // 1. Hooks.
    const hooks = await retireSettingsHooks(deps.settingsPath);
    if (hooks.kind === "refused") problems.push(hooks.reason);
    else if (hooks.kind === "rewritten") notes.push(`removed ${hooks.removed} limit hook row(s) from ${deps.settingsPath}`);

    const parent = directoryIdentity(globalDir);
    if (typeof parent === "string") {
      problems.push(parent);
      return { kind: "incomplete", problems, notes };
    }

    // 2. Waker. A waker that could not be stopped keeps waker.lock and the ledger.
    const wakerLock = join(globalDir, WAKER_LOCK_BASENAME);
    const waker = await stopRetiredWaker(wakerLock, deps.waker);
    if (waker.kind === "refused") {
      problems.push(waker.reason);
      return { kind: "incomplete", problems, notes };
    }
    if (waker.kind === "stopped") notes.push(`stopped the retired waker${waker.killed ? " (SIGKILL)" : ""}`);

    // 3. Ledger attempts. Nothing is signalled; a live or unknown attempt holds the ledger.
    const ledgerPath = join(globalDir, LEDGER_BASENAME);
    const ledger = readOwnedFileNoFollow(ledgerPath, LEDGER_MAX_BYTES);
    let sessions: readonly ReferencedSession[] = [];
    let blocking = false;
    if (ledger.kind === "refused") {
      problems.push(ledger.reason);
      blocking = true;
    } else if (ledger.kind === "ok") {
      const reading = classifyLedger(ledger.text, deps.probes);
      if (reading.kind === "malformed") {
        problems.push(`${ledgerPath}: ${reading.reason}, left in place`);
        blocking = true;
      } else {
        sessions = reading.sessions;
        for (const attempt of reading.attempts) {
          if (attempt.verdict !== "gone") problems.push(`wake attempt ${attempt.attemptId ?? attempt.recordKey} kept: ${attempt.reason}`);
        }
        blocking = reading.blocking;
      }
    }

    // 4. Sessions, best effort: reported, never relied on.
    try {
      for (const skipped of await deps.normalizeSessions(sessions)) notes.push(`session skipped: ${skipped}`);
    } catch (err) {
      notes.push(`session normalisation failed: ${errorCode(err)}`);
    }
    if (blocking) return { kind: "incomplete", problems, notes };

    // 5. Artifacts.
    const claimsRoot = join(globalDir, WAKE_CLAIMS_DIRNAME);
    const guard = (): string | null => {
      const now = directoryIdentity(globalDir);
      if (typeof now === "string") return now;
      return now.dev === parent.dev && now.ino === parent.ino ? null : `${globalDir}: replaced during retirement`;
    };
    const tree = inspectTreeForRemoval(claimsRoot);
    if (tree.kind === "refused") problems.push(...tree.reasons);
    else if (tree.kind === "ok") {
      const removal = removeInspectedTree(tree.nodes, guard);
      if (removal.kind === "aborted") problems.push(removal.reason);
    }
    const wakerFile = waker.kind === "absent" ? null : { dev: waker.dev, ino: waker.ino };
    if (wakerFile !== null) {
      const refused = unlinkIdentified(wakerLock, wakerFile);
      if (refused !== null) problems.push(refused);
    }
    const config = retireGlobalConfigMember(join(globalDir, "config.json"));
    if (config.kind === "refused") problems.push(config.reason);
    if (problems.length > 0) return { kind: "incomplete", problems, notes };

    // 6. Ledger last, through its own lock, then the marker.
    const ledgerRefused = removeLedgerUnderLock(globalDir, ledger.kind === "ok" ? ledger : null, deps.ledgerHooks);
    if (ledgerRefused !== null) return { kind: "incomplete", problems: [ledgerRefused], notes };
    const markerFailed = writeMarker(globalDir, deps.cliVersion);
    if (markerFailed !== null) return { kind: "incomplete", problems: [markerFailed], notes };
    return { kind: "retired", notes };
  } finally {
    releaseProjectLock(handle);
  }
}
