import {
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import {
  CURRENT_STATUS_SCHEMA_VERSION,
  type SessionState,
  type StatusPayload,
} from "./session-types.js";
import { buildActivePayload, buildInactivePayload } from "./status-payload.js";
import { readLastMcpCall, readOwnerHeartbeat } from "./liveness.js";
import { readSubprocessSummaries } from "./subprocess-registry.js";
import { collectProbes, reduceHealthState } from "./health-model.js";

export function isSessionActiveForStatus(state: SessionState | Record<string, unknown>): boolean {
  const status = (state as Record<string, unknown>).status;
  const workflowState = (state as Record<string, unknown>).state;
  return status === "active" && workflowState !== "SESSION_END";
}

export function atomicWriteSync(targetPath: string, content: string): boolean {
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, targetPath);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content gate (ISS-1012)
// ---------------------------------------------------------------------------

const STATUS_MAX_BYTES = 256 * 1024;
const NO_FOLLOW_MAX_ATTEMPTS = 5;

/**
 * The complete set of fields that differ between two writes describing an
 * UNCHANGED project: the observation stamp, and which writer produced it.
 * Everything else in the payload -- including the clock-derived `leaseState`
 * and `healthState` verdicts -- stays in the comparison, because a change
 * there is reader-visible signal that must reach the file.
 */
const VOLATILE_STATUS_FIELDS = ["observedAt", "lastWrittenBy"] as const;

/**
 * Sync, silent, no-follow bounded read of the CURRENT status.json.
 *
 * Every `null` means "cannot prove the file already says this", which fails the
 * gate OPEN to a write -- absent, oversized, unreadable and corrupt all take
 * that path. A symlink is refused for a stronger reason than safety of this
 * read: status.json is a GENERATED artifact, so a symlink at that path is a
 * defect that `atomicWriteSync`'s rename heals today, and a gate that compared
 * through the link would instead preserve externally-controlled content behind
 * an equivalence skip, feeding it to Mac/websocket/CloudKit consumers forever.
 * (`.story/config.json` is USER input and takes the opposite policy -- see
 * core/limit-config.ts.)
 *
 * The lstat floor is the PORTABLE half of that refusal: lstat never follows, so
 * a symlink is rejected even where `O_NOFOLLOW` is unavailable and the open
 * cannot enforce it. The dev/ino identity check closes the residual lstat->open
 * window, where a mismatch is either a benign concurrent rename (our own other
 * writer) or a swap, and a bounded retry re-reads the current file. This
 * mirrors openReadNoFollow in src/bus/io.ts, in sync + never-throwing form
 * because it runs on the Stop-hook hot path.
 */
function readCurrentStatusNoFollow(path: string): string | null {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  // O_NONBLOCK so a swap to a FIFO cannot block the open before identity is verified.
  const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  for (let attempt = 0; attempt < NO_FOLLOW_MAX_ATTEMPTS; attempt++) {
    let fd: number | null = null;
    try {
      const linkStat = lstatSync(path);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
      fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlock);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== linkStat.dev || opened.ino !== linkStat.ino) {
        continue; // identity changed under us -- re-lstat and try again
      }
      if (opened.size <= 0 || opened.size > STATUS_MAX_BYTES) return null;
      // Bound the READ, not just the pre-read stat: the same inode can grow
      // between fstat and read, so this loop is the real allocation ceiling.
      const cap = STATUS_MAX_BYTES + 1;
      const buf = Buffer.allocUnsafe(cap);
      let total = 0;
      while (total < cap) {
        const n = readSync(fd, buf, total, cap - total, total);
        if (n <= 0) break;
        total += n;
      }
      if (total > STATUS_MAX_BYTES) return null;
      return buf.subarray(0, total).toString("utf-8");
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return null;
}

/** Key-order-independent serialization, so a key reordering across CLI versions cannot manufacture an equality bug. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Collision-resistant canonical order for a readdir-ordered array (subprocess-registry does not sort). */
function subprocessSortKey(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const e = entry as Record<string, unknown>;
  // JSON-encoded tuple: escaping makes the element boundaries unambiguous, so no
  // separator character can be forged inside a value to collide two distinct entries.
  return JSON.stringify([e.pid, e.category, e.startedAt, e.stage].map((v) => String(v ?? "")));
}

/**
 * A previous value we refuse to compare is a previous value we REWRITE. Without
 * this, a malformed status.json is preserved forever: an active payload missing
 * `observedAt` compares equal once that field is excluded, so the defect would
 * never heal.
 */
function previousIsComparable(prev: unknown, next: StatusPayload): boolean {
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) return false;
  const p = prev as Record<string, unknown>;
  if (p.schemaVersion !== CURRENT_STATUS_SCHEMA_VERSION) return false;
  if (typeof p.sessionActive !== "boolean") return false;
  if (p.sessionActive !== next.sessionActive) return false;
  if (p.lastWrittenBy !== undefined && p.lastWrittenBy !== "hook" && p.lastWrittenBy !== "guide") return false;
  if (p.sessionActive === true && (typeof p.observedAt !== "string" || p.observedAt.length === 0)) return false;
  return true;
}

/** Deep copy first: comparison must never mutate the caller's payload. */
function canonicalizeForComparison(payload: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  for (const field of VOLATILE_STATUS_FIELDS) delete copy[field];
  const subs = copy.runningSubprocesses;
  if (Array.isArray(subs)) {
    copy.runningSubprocesses = [...subs].sort((a, b) => {
      const ka = subprocessSortKey(a);
      const kb = subprocessSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  return copy;
}

/**
 * EXPORTED for test. True when writing `next` would leave status.json saying
 * exactly what it already says, modulo VOLATILE_STATUS_FIELDS.
 */
export function statusPayloadsEquivalent(next: StatusPayload, prevRaw: string): boolean {
  try {
    const prev: unknown = JSON.parse(prevRaw);
    if (!previousIsComparable(prev, next)) return false;
    return stableStringify(canonicalizeForComparison(prev)) === stableStringify(canonicalizeForComparison(next));
  } catch {
    return false;
  }
}

/**
 * ISS-1012: skip the write when the file already says this.
 *
 * The Stop hook fires at EVERY turn end and the write was unconditional, so a
 * project's tree changed (temp file + rename, new inode) on every turn even
 * with nothing to report -- which deterministically tripped a host project's
 * test-isolation fence, and cost every consumer a redundant decode, menu-bar
 * rebuild, websocket broadcast and CloudKit save per turn.
 *
 * NO cross-process lock, deliberately: the read-compare-skip window can
 * interleave with the other writer, but the only interleaving the gate changes
 * is "B wrote newer state between our read and our decision", where skipping
 * LEAVES B's newer content in place -- strictly better than the unconditional
 * write, which clobbered it with ours. `true` has always meant "reflected at
 * decision time"; it is equally stale one microsecond later, lock or no lock.
 * A lock FILE under `.story/` would also be the exact class of tree mutation
 * this change exists to remove.
 */
export function writeStatusFile(root: string, payload: StatusPayload): boolean {
  try {
    const statusPath = join(root, ".story", "status.json");
    const content = JSON.stringify(payload, null, 2) + "\n";
    const current = readCurrentStatusNoFollow(statusPath);
    if (current !== null && statusPayloadsEquivalent(payload, current)) return true;
    return atomicWriteSync(statusPath, content);
  } catch {
    return false;
  }
}

export function refreshStatusForSession(
  root: string,
  dir: string,
  state: SessionState | Record<string, unknown>,
  lastWrittenBy: "hook" | "guide",
): boolean {
  try {
    if (isSessionActiveForStatus(state)) {
      const lastMcpCall = readLastMcpCall(dir);
      // T-450 step 7b.4: the OWNER's heartbeat, and `unusable` surfaces as an
      // explicit unknown. `false` is a claim that nobody is there; a read fault
      // is a refusal to claim anything, and the payload field is already
      // nullable to carry exactly that difference.
      const heartbeat = readOwnerHeartbeat(dir, state as { heartbeatGeneration?: unknown });
      const subprocesses = readSubprocessSummaries(dir);
      // ISS-1012: compute the health verdict here exactly as the hook does
      // (hook-status.ts activePayload). Nothing assigns `session.healthState`,
      // so without this the guide wrote `healthState: null` over the hook's
      // real verdict on every transition -- the file flapped null/real as the
      // two writers alternated, which is both a latent inconsistency for
      // readers and the reason a content gate could never skip during an
      // active session. Same snapshot as `alive` above, for the same reason.
      const healthState = reduceHealthState(collectProbes(dir, undefined, state as Record<string, unknown>));
      const activePayload = buildActivePayload(state as SessionState, {
        lastMcpCall,
        alive: heartbeat.kind === "unusable" ? null : heartbeat.kind === "alive",
        runningSubprocesses: subprocesses.length > 0 ? subprocesses : null,
        healthState,
      });
      const payload = { ...activePayload, lastWrittenBy } as StatusPayload;
      return writeStatusFile(root, payload);
    }

    const inactivePayload = { ...buildInactivePayload(), lastWrittenBy } as StatusPayload;
    return writeStatusFile(root, inactivePayload);
  } catch {
    return false;
  }
}
