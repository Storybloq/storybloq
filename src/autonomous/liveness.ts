import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SuccessorServers } from "./mcp-registry.js";
import { isSameOwnerTask, type OwnerTask } from "./client-profile.js";
import { encodeBase32Crockford } from "../core/canonical-id.js";
import { CROCKFORD_CLASS } from "../models/types.js";

const LOCK_BASENAME = "sidecar.lock";
const PID_BASENAME = "sidecar.pid";
const ACQUIRE_DEADLINE_MS = 2_000;
const ACQUIRE_POLL_MS = 25;
const STALENESS_FLOOR_MS = 5_000;
const UNREADABLE_BREAK_MS = 10 * STALENESS_FLOOR_MS;
const KILL_GRACE_MS = 500;
const KILL_POLL_MS = 50;
const LOCK_MAX_BYTES = 4_096;
const CMDLINE_MAX_BYTES = 128 * 1024;
const SIDECAR_SENTINEL = "CLAUDESTORY_SIDECAR_V1";
const SIDECAR_ARGV_MARKER = "--" + SIDECAR_SENTINEL.toLowerCase().replace(/_/g, "-");
const SIDECAR_PID_MAX_BYTES = 64;

// Mutable indirection so tests can replace methods (vi.spyOn cannot mock ESM
// module-namespace exports directly).
/** Seamed so readiness regressions fail fast instead of blocking the event loop. */
const timeApi = { sleepMs: (ms: number) => sleepMs(ms) };

const fsApi = {
  linkSync: fs.linkSync,
  renameSync: fs.renameSync,
  // Seamed for the same reason as the probes below: the arms that distinguish
  // "not there" from "could not tell" are the fail-closed ones, and an
  // indeterminate `realpath` or `lstat` failure is not reachable from a fixture
  // on a real filesystem.
  realpathSync: fs.realpathSync,
  lstatSync: fs.lstatSync,
};

interface LockBody { pid: number; token: string; acquiredAt: number; }
interface LockHandle { token: string; lockPath: string; tmpPath: string; lockIno: number | null; }
type LockState = "holder-alive" | "holder-grace" | "holder-dead" | "unreadable";
interface LockInspection { state: LockState; ino: number | null; token: string | null; }

const SIDECAR_SCRIPT = [
  `// ${SIDECAR_SENTINEL}`,
  'const fs=require("fs"),path=require("path");',
  "const dir=process.argv[1],ms=+process.argv[2],ppid=process.ppid;",
  'const alive=path.join(dir,"alive"),shut=path.join(dir,"shutdown");',
  "const tick=()=>{",
  "  if(process.ppid!==ppid){try{fs.writeFileSync(alive,\"0\")}catch{}process.exit(0)}",
  "  if(fs.existsSync(shut)){try{fs.writeFileSync(alive,\"0\")}catch{}process.exit(0)}",
  "  try{fs.writeFileSync(alive,String(Date.now()))}catch{}",
  "};",
  "tick();setInterval(tick,ms);",
].join("\n");

if (!SIDECAR_SCRIPT.includes(SIDECAR_SENTINEL)) {
  throw new Error(
    "liveness.ts: SIDECAR_SCRIPT lost sentinel " + SIDECAR_SENTINEL +
    ": PID-reuse guard cannot match the sidecar in ps/proc output; refusing to load."
  );
}

function livenessLog(tag: string, detail: Record<string, unknown>): void {
  const debug = process.env.STORYBLOQ_LIVENESS_DEBUG ?? process.env.CLAUDESTORY_LIVENESS_DEBUG;
  if (debug !== "1") return;
  try { process.stderr.write("liveness:" + tag + " " + JSON.stringify(detail) + "\n"); } catch { /* best-effort */ }
}

export function sleepMs(ms: number): void {
  if (ms <= 0) return;
  const deadline = Date.now() + ms;
  try {
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    // Loop because Atomics.wait can return early (not-equal, ok, or
    // spurious wakeups on some platforms); honor the full requested sleep.
    let remaining = ms;
    while (remaining > 0) {
      Atomics.wait(i32, 0, 0, remaining);
      remaining = deadline - Date.now();
    }
  } catch {
    while (Date.now() < deadline) { /* bounded busy-wait fallback */ }
  }
}

function safeStatIno(p: string): number | null {
  try { return fs.statSync(p).ino; } catch { return null; }
}

function randomHex4(): string {
  return randomBytes(2).toString("hex");
}

function getOurUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function isSelfPid(pid: number): boolean {
  return pid === process.pid || pid === process.ppid || pid === 1;
}

function getProcessPpid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const n = Number(out.trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const rp = raw.lastIndexOf(")");
      if (rp < 0) return null;
      const rest = raw.slice(rp + 1).trim().split(/\s+/);
      const n = Number(rest[1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Same-uid argv-marker check: true only when `pid` is alive, owned by our uid,
 * and its command line carries EVERY one of `markers` (all-markers semantics:
 * a process matching only some markers -- e.g. an interactive `claude --resume
 * <id>` sharing the session UUID with a wake child -- is a non-match). Bare
 * kill(pid,0) liveness is NOT PID-reuse-safe; this is the identity layer that
 * makes it safe. Exported for T-424 (waker sentinel + wake-child identity).
 */
export function hasArgvSignature(pid: number, markers: readonly string[]): boolean {
  return probeArgvSignature(pid, markers) === "match";
}

/**
 * Tri-state argv identity probe. "match" = the process exists, belongs to us,
 * and carries EVERY marker. "absent" = the process is gone, belongs to another
 * uid, or its (readable) argv lacks a marker -- i.e. the identified child is
 * definitively not there (dead or PID-reused). "unknown" = the process EXISTS
 * (kill(pid, 0) reaches it) but its argv could not be inspected (ps failure,
 * truncated /proc read, unsupported platform); callers supervising a child
 * must treat "unknown" as possibly-alive and retry, never as confirmed death.
 */
export function probeArgvSignature(pid: number, markers: readonly string[]): "match" | "absent" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "absent";
  if (markers.length === 0) return "absent";
  let exists = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return "absent";
    // EPERM: exists but not ours -> the uid checks below would reject it
    // anyway; treat as PID reuse by another user.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return "absent";
    exists = false; // unexpected failure: fall through to argv inspection
  }
  try {
    if (process.platform === "darwin") {
      // `-ww` = unlimited width: without it BSD `ps` truncates the command
      // column (~default width), which would drop a marker that sits near the
      // END of a long argv -- e.g. the wake-child attempt sentinel at the tail
      // of a ~280-char prompt -- making a LIVE child read as "absent" (a
      // positively-confirmed death). That would let the supervisor spawn a
      // second child on the same transcript. Full width keeps every marker
      // visible so all-markers matching is sound.
      const out = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=,command="], {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = out.trim();
      if (!line) return exists ? "unknown" : "absent";
      const firstSpace = line.indexOf(" ");
      if (firstSpace < 0) return "unknown";
      const uid = Number(line.slice(0, firstSpace).trim());
      const command = line.slice(firstSpace + 1);
      const myUid = getOurUid();
      if (myUid < 0) return "unknown";
      if (uid !== myUid) return "absent";
      return markers.every((m) => command.includes(m)) ? "match" : "absent";
    }
    if (process.platform === "linux") {
      const pidDir = "/proc/" + pid;
      const st1 = fs.statSync(pidDir);
      const myUid = getOurUid();
      if (myUid < 0) return "unknown";
      if (st1.uid !== myUid) return "absent";
      const fd = fs.openSync(pidDir + "/cmdline", "r");
      try {
        // procfs cmdline reports st_size 0, so size the buffer at the cap. A
        // single readSync can also SHORT-read; loop until EOF or the cap. If the
        // cap fills WITHOUT EOF a required marker may lie beyond it -> return
        // "unknown" (possibly-alive), NEVER "absent" (a false confirmed death
        // would let the supervisor spawn a second child on the same transcript).
        const buf = Buffer.alloc(CMDLINE_MAX_BYTES);
        let read = 0;
        let sawEof = false;
        while (read < buf.length) {
          const n = fs.readSync(fd, buf, read, buf.length - read, read);
          if (n <= 0) { sawEof = true; break; }
          read += n;
        }
        const st2 = fs.statSync(pidDir);
        if (st2.uid !== st1.uid || st2.ino !== st1.ino) return "unknown";
        if (!sawEof) return "unknown"; // cap filled before EOF: cannot rule out a marker past it
        const cmd = buf.slice(0, read).toString("utf-8").replace(/\0/g, " ");
        return markers.every((m) => cmd.includes(m)) ? "match" : "absent";
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    // Unsupported platform: existence is known, identity is not.
    return "unknown";
  } catch {
    // ps/proc inspection failed while kill(pid, 0) says the process exists:
    // identity is unknown -- do NOT report a live pid as absent.
    return exists ? "unknown" : "absent";
  }
}

function hasSidecarSignature(pid: number): boolean {
  // ANY-marker contract (preserved from the pre-T-424 implementation): the
  // osascript sidecar command line is long and `ps -o command=` can truncate
  // it, so a live sidecar may show only one of the two markers. Requiring BOTH
  // (all-markers) would misclassify such a sidecar as absent and let it be
  // replaced/killed. All-markers semantics are correct only for wake-child
  // identity (session UUID + attempt id must both be present); the sidecar
  // deliberately matches on either. `||` short-circuits, so the common
  // both-markers-present case stays a single probe.
  return hasArgvSignature(pid, [SIDECAR_ARGV_MARKER]) || hasArgvSignature(pid, [SIDECAR_SENTINEL]);
}

function waitForExit(pid: number, deadlineMs: number, signatureGuard: () => boolean): "exited" | "timeout" | "lost-signature" {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try { process.kill(pid, 0); }
    catch (e: any) { if (e && e.code === "ESRCH") return "exited"; }
    if (!signatureGuard()) return "lost-signature";
    sleepMs(KILL_POLL_MS);
  }
  return "timeout";
}

function inspectExistingLock(lockPath: string): LockInspection {
  try {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      return { state: "unreadable", ino: null, token: null };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { state: "unreadable", ino: st.ino ?? null, token: null };
      const myUid = getOurUid();
      if (myUid >= 0 && st.uid !== myUid) return { state: "unreadable", ino: st.ino, token: null };
      if (st.size > LOCK_MAX_BYTES || st.size < 0) return { state: "unreadable", ino: st.ino, token: null };
      const buf = Buffer.alloc(Math.min(st.size || 0, LOCK_MAX_BYTES));
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, 0);
      const raw = buf.toString("utf-8");
      let body: any;
      try { body = JSON.parse(raw); } catch { return { state: "unreadable", ino: st.ino, token: null }; }
      if (!body || typeof body !== "object") return { state: "unreadable", ino: st.ino, token: null };
      if (!Number.isInteger(body.pid) || body.pid <= 0) return { state: "unreadable", ino: st.ino, token: null };
      if (typeof body.token !== "string" || body.token.length === 0) return { state: "unreadable", ino: st.ino, token: null };
      if (!Number.isFinite(body.acquiredAt) || body.acquiredAt <= 0) return { state: "unreadable", ino: st.ino, token: null };

      // EPERM means pid exists but we cannot signal it: another uid owns it.
      // That cannot be our sidecar; treat as dead for staleness purposes to
      // avoid a PID-reuse wedge where the recorded pid was recycled to
      // another user and the lock becomes un-breakable until that process
      // exits. ESRCH is definitive dead.
      let owner: "alive" | "dead";
      try {
        process.kill(body.pid, 0);
        owner = "alive";
      } catch (e: any) {
        if (e && e.code === "ESRCH") owner = "dead";
        else if (e && e.code === "EPERM") owner = "dead";
        else owner = "alive";
      }
      const token: string = body.token;
      if (owner === "alive") return { state: "holder-alive", ino: st.ino, token };
      if (body.acquiredAt > Date.now()) return { state: "holder-grace", ino: st.ino, token }; // clock skew
      if (Date.now() - body.acquiredAt > STALENESS_FLOOR_MS) return { state: "holder-dead", ino: st.ino, token };
      return { state: "holder-grace", ino: st.ino, token };
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return { state: "unreadable", ino: null, token: null };
  }
}

export type UnlinkResult =
  | { unlinked: true }
  | { unlinked: false; reason: "foreign" | "symlink" | "error" | "raced" };

// Narrow the lstat/unlink TOCTOU window by holding an fd across the
// verification. When expectedInode/expectedToken are provided we require the
// currently-linked file to match before unlinking, which protects against a
// concurrent holder replacing the lock between inspect and unlink.
// expectedRenewedAt additionally fences against an IN-PLACE lease renewal by the
// SAME holder (same inode+token, newer renewedAt): a lease that looked stealable
// at inspect time is fresh again and must NOT be stolen. Exported for T-424
// (limit-lock reuses the verified-unlink primitive).
export function safeUnlinkLock(
  lockPath: string,
  expectedInode?: number | null,
  expectedToken?: string | null,
  expectedRenewedAt?: number | null,
): UnlinkResult {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e: any) {
    if (e && e.code === "ENOENT") return { unlinked: true };
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) {
      return { unlinked: false, reason: "symlink" };
    }
    livenessLog("safe-unlink-open-error", { code: e?.code, path: lockPath });
    return { unlinked: false, reason: "error" };
  }
  try {
    let st: fs.Stats;
    try { st = fs.fstatSync(fd); }
    catch (e: any) {
      livenessLog("safe-unlink-fstat-error", { code: e?.code });
      return { unlinked: false, reason: "error" };
    }
    if (!st.isFile()) return { unlinked: false, reason: "foreign" };
    const myUid = getOurUid();
    if (myUid >= 0 && st.uid !== myUid) return { unlinked: false, reason: "foreign" };
    if (expectedInode !== undefined && expectedInode !== null && st.ino !== expectedInode) {
      return { unlinked: false, reason: "raced" };
    }
    // Optional content re-verification: the caller observed `expectedToken`
    // in a prior inspect; if the current body parses as valid JSON with a
    // different token, a new holder has raced in and we must not unlink.
    //
    // An unparseable body is treated as corruption on OUR inode (we already
    // verified it above), not a race. The caller can still proceed to
    // unlink. This preserves the invariant that a valid, differently-owned
    // lock is never broken while letting us release corrupted bodies on
    // inodes we own.
    if ((expectedToken != null || expectedRenewedAt != null) && st.size <= LOCK_MAX_BYTES && st.size >= 0) {
      const buf = Buffer.alloc(Math.min(st.size || 0, LOCK_MAX_BYTES));
      let bodyParsed: any = null;
      let parseOk = false;
      try {
        if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, 0);
        bodyParsed = JSON.parse(buf.toString("utf-8"));
        parseOk = true;
      } catch { /* unparseable: treat as corruption on our inode */ }
      if (parseOk && bodyParsed && typeof bodyParsed === "object") {
        // A NEW holder raced in (different token) -> never unlink.
        if (expectedToken != null &&
            typeof bodyParsed.token === "string" &&
            bodyParsed.token !== expectedToken) {
          return { unlinked: false, reason: "raced" };
        }
        // The SAME holder renewed the lease in place (same token+inode, newer
        // renewedAt) after we inspected it as stealable -> the lock is fresh, so
        // stealing it would evict a live holder and violate singleton ownership.
        if (expectedRenewedAt != null &&
            typeof bodyParsed.renewedAt === "number" &&
            Number.isFinite(bodyParsed.renewedAt) &&
            bodyParsed.renewedAt !== expectedRenewedAt) {
          return { unlinked: false, reason: "raced" };
        }
      }
    }
    // Final lstat right before unlink to catch a path swap (unlink + link by
    // another process) between our fd-based verification and the unlink call.
    // Inode is still verified against our open fd's inode via st above.
    try {
      const lst = fs.lstatSync(lockPath);
      if (lst.isSymbolicLink()) return { unlinked: false, reason: "symlink" };
      if (lst.ino !== st.ino) return { unlinked: false, reason: "raced" };
    } catch (e: any) {
      if (e && e.code === "ENOENT") return { unlinked: true };
      livenessLog("safe-unlink-lstat-error", { code: e?.code });
      return { unlinked: false, reason: "error" };
    }
    try { fs.unlinkSync(lockPath); return { unlinked: true }; }
    catch (e: any) {
      if (e && e.code === "ENOENT") return { unlinked: true };
      livenessLog("safe-unlink-error", { code: e?.code, path: lockPath });
      return { unlinked: false, reason: "error" };
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function acquireSpawnLock(tDir: string): LockHandle | null {
  const token = randomBytes(16).toString("hex");
  const body: LockBody = { pid: process.pid, token, acquiredAt: Date.now() };
  const lockPath = join(tDir, LOCK_BASENAME);
  const tmpPath = join(tDir, `${LOCK_BASENAME}.tmp.${process.pid}.${Date.now()}.${randomHex4()}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
  } catch (e: any) {
    livenessLog("lock-tmp-write-failed", { code: e?.code });
    throw e;
  }
  let success = false;
  let foreignBreakCount = 0;
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ACQUIRE_DEADLINE_MS) {
      try {
        fsApi.linkSync(tmpPath, lockPath);
        const ino = safeStatIno(lockPath);
        success = true;
        return { token, lockPath, tmpPath, lockIno: ino };
      } catch (err: any) {
        const code = err?.code;
        if (code === "EEXIST") {
          const inspection = inspectExistingLock(lockPath);
          const { state, ino, token: observedToken } = inspection;
          if (state === "holder-alive" || state === "holder-grace") {
            sleepMs(ACQUIRE_POLL_MS);
            continue;
          }
          if (state === "holder-dead") {
            // Pass observed inode+token so safeUnlinkLock can abort if the
            // dead holder has been replaced between inspect and unlink.
            const r = safeUnlinkLock(lockPath, ino, observedToken);
            if (!r.unlinked) {
              // "raced" means a new holder appeared; treat as retry, not wedge.
              if (r.reason !== "raced") foreignBreakCount++;
              if (foreignBreakCount >= 2) {
                livenessLog("lock-foreign-wedged", { reason: r.reason });
                return null;
              }
              sleepMs(ACQUIRE_POLL_MS);
            }
            continue;
          }
          if (state === "unreadable") {
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(lockPath).mtimeMs; } catch { /* ignore */ }
            if (mtimeMs > 0 && Date.now() - mtimeMs > UNREADABLE_BREAK_MS) {
              // Unreadable lock has no token to verify; pass inode only.
              const r = safeUnlinkLock(lockPath, ino, null);
              if (!r.unlinked) {
                if (r.reason !== "raced") foreignBreakCount++;
                if (foreignBreakCount >= 2) {
                  livenessLog("lock-unreadable-wedged", { reason: r.reason });
                  return null;
                }
              }
              continue;
            }
            sleepMs(ACQUIRE_POLL_MS);
            continue;
          }
        }
        if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP" || code === "ENOSYS") {
          livenessLog("lock-unsupported-fs", { code });
          return null;
        }
        throw err;
      }
    }
    livenessLog("lock-acquire-timeout", {});
    return null;
  } finally {
    if (!success) {
      try { fs.unlinkSync(tmpPath); }
      catch (e: any) { if (e?.code !== "ENOENT") livenessLog("lock-tmp-unlink-failed", { code: e?.code }); }
    }
  }
}

function releaseSpawnLock(handle: LockHandle): void {
  // Inode + token verified unlink under a held fd. safeUnlinkLock:
  //   - refuses if inode diverges from handle.lockIno (swap by other holder)
  //   - refuses if body parses to a different token (another holder rewrote)
  //   - proceeds if body is unparseable on our inode (external corruption)
  safeUnlinkLock(handle.lockPath, handle.lockIno, handle.token);
  try { fs.unlinkSync(handle.tmpPath); }
  catch (e: any) { if (e?.code !== "ENOENT") livenessLog("release-tmp-unlink-failed", { code: e?.code }); }
}

function readSidecarPid(tDir: string): number | null {
  let fd: number;
  try { fd = fs.openSync(join(tDir, PID_BASENAME), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { return null; }
  try {
    // Inner block swallows all errors so callers see a clean null-or-number
    // contract. Without this, fstatSync/readSync could throw on races
    // (truncation, file removed mid-read) and propagate to spawnAliveSidecar.
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const myUid = getOurUid();
      if (myUid >= 0 && st.uid !== myUid) return null;
      if (st.size > SIDECAR_PID_MAX_BYTES || st.size < 0) return null;
      const buf = Buffer.alloc(Math.min(st.size || 0, SIDECAR_PID_MAX_BYTES));
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, 0);
      const raw = buf.toString("utf-8").trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return null;
      if (isSelfPid(n)) return null;
      return n;
    } catch (e: any) {
      livenessLog("read-sidecar-pid-error", { code: e?.code });
      return null;
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function writeSidecarPid(tDir: string, pid: number): void {
  const target = join(tDir, PID_BASENAME);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${randomHex4()}`;
  try {
    fs.writeFileSync(tmp, String(pid), { mode: 0o600 });
    fsApi.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function unlinkSidecarPid(tDir: string): void {
  try { fs.unlinkSync(join(tDir, PID_BASENAME)); }
  catch { /* may not exist */ }
}

function safetyCheck(pid: number): "already-dead" | "not-ours" | "proceed" {
  if (!Number.isInteger(pid) || pid <= 0) return "not-ours";
  if (isSelfPid(pid)) return "not-ours";
  try { process.kill(pid, 0); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return "already-dead";
    // EPERM / any other error: pid exists but is not ours to signal.
    return "not-ours";
  }
  if (!hasSidecarSignature(pid)) return "not-ours";
  return "proceed";
}

function escalate(
  pid: number,
  signal: NodeJS.Signals,
  hasSig: (p: number) => boolean = hasSidecarSignature,
): "exited" | "lost-signature" | "timeout" | "cannot-signal" {
  // Re-verify sidecar signature immediately before signaling to narrow the
  // PID-reuse TOCTOU between safetyCheck and this kill. If the pid was
  // recycled to an unrelated process after safetyCheck, abort rather than
  // risk signaling that process.
  if (!hasSig(pid)) return "lost-signature";
  try { process.kill(pid, signal); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return "exited";
    livenessLog("escalate-cannot-signal", { signal, code: e?.code });
    return "cannot-signal";
  }
  return waitForExit(pid, KILL_GRACE_MS, () => hasSig(pid));
}

function finalVerify(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (e: any) { if (e && e.code === "ESRCH") return true; /* EPERM: alive */ }
  return !hasSidecarSignature(pid);
}

function killJustSpawnedChild(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isSelfPid(pid)) return;
  try { process.kill(pid, "SIGTERM"); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return;
    livenessLog("orphan-kill-term-failed", { pid, code: e?.code });
  }
  const start = Date.now();
  while (Date.now() - start < KILL_GRACE_MS) {
    try { process.kill(pid, 0); }
    catch (e: any) { if (e && e.code === "ESRCH") return; }
    sleepMs(KILL_POLL_MS);
  }
  try { process.kill(pid, "SIGKILL"); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return;
    livenessLog("orphan-kill-kill-failed", { pid, code: e?.code });
  }
}

function killPriorSidecarImpl(priorPid: number): boolean {
  const gate = safetyCheck(priorPid);
  if (gate !== "proceed") return true;
  const termResult = escalate(priorPid, "SIGTERM");
  if (termResult === "exited" || termResult === "lost-signature") return true;
  if (termResult === "cannot-signal") return false;
  if (!hasSidecarSignature(priorPid)) return true;
  const killResult = escalate(priorPid, "SIGKILL");
  if (killResult === "exited" || killResult === "lost-signature") return true;
  if (killResult === "cannot-signal") return false;
  return finalVerify(priorPid);
}

export function telemetryDirPath(sessionDir: string): string {
  return join(sessionDir, "telemetry");
}

/** A child staging spawned, with the exact means of stopping it. */
export interface StagedChild {
  readonly pid: number;
  /**
   * Terminates through the retained `ChildProcess` capability rather than a
   * number read off a handle. Node's `kill()` does ultimately signal the stored
   * pid, so this is not immunity from pid reuse; see ISS-930 for the one window
   * where that distinction bites and why it is unreachable here today.
   */
  terminate(): void;
}

/**
 * Stop a child we hold the handle for.
 *
 * The handle is what makes this safe, though NOT because a `ChildProcess` is a
 * pidfd: Node still signals the stored number. It is safe because a number can
 * only be recycled once the parent REAPS the child, Node reaps on the event
 * loop, and this wait blocks that loop. A child that exits inside the grace
 * window therefore stays a zombie holding its own number until we return, so
 * neither signal can land on a replacement. Measured, not assumed: during the
 * blocked wait an exited child still reports `exitCode === null` and its pid is
 * still addressable; both flip only after the loop turns.
 *
 * The case where the number IS unsafe is a child reaped BEFORE we are called,
 * which is what a delayed discard looks like. That child reports its exit and
 * we do not signal it. Note the asymmetry, because it is easy to overstate: the
 * "a reaped child reports its exit" premise is guaranteed DURING the wait, where
 * the loop cannot turn so nothing can be reaped, but only USUALLY true at entry.
 * libuv reaps a whole batch of sibling children before dispatching any of their
 * exit callbacks, so inside such a callback a sibling can report `exitCode ===
 * null` with its number already released. That window is not reachable from here
 * today and ISS-930 records both why and what would make it reachable.
 * There is deliberately no second check before escalating:
 * `exitCode` provably cannot change while we hold the loop, so a recheck there
 * would re-read the same value and imply a protection that is really coming
 * from the reaping invariant above. Reaching the escalation means the pid was
 * still addressable on the last poll, and it can only still be addressable
 * because it is our child, live or unreaped.
 */
function terminateChild(child: ChildProcess, pid: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const start = Date.now();
  while (Date.now() - start < KILL_GRACE_MS) {
    // Read-only. Proves the child is gone without signalling anything.
    try { process.kill(pid, 0); } catch (e: any) { if (e && e.code === "ESRCH") return; }
    sleepMs(KILL_POLL_MS);
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

function spawnAliveSidecarChild(tDir: string, intervalMs = 10_000): StagedChild | null {
  try {
    fs.mkdirSync(tDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(tDir, 0o700); } catch { /* best-effort */ }
  } catch { /* best-effort */ }

  const handle = acquireSpawnLock(tDir);

  if (handle === null) {
    const existing = readSidecarPid(tDir);
    if (existing === null) return null;
    try { process.kill(existing, 0); } catch { return null; }
    if (!hasSidecarSignature(existing)) return null;
    // ADOPTED, not spawned. We hold no handle for it and it is not ours to
    // stop. Unreachable from staging, which always creates a fresh directory
    // that cannot already contain a sidecar.
    return { pid: existing, terminate: () => {} };
  }

  let spawned: StagedChild | null = null;
  try {
    const priorPid = readSidecarPid(tDir);
    if (priorPid !== null) {
      let priorAliveWithSignature = false;
      try { process.kill(priorPid, 0); priorAliveWithSignature = hasSidecarSignature(priorPid); }
      catch { /* dead or unreachable */ }

      if (priorAliveWithSignature) {
        // Fail closed: only proceed if we can affirmatively confirm the prior
        // sidecar was spawned by us. A null ppid (ps/proc lookup transient
        // failure) is not evidence of ownership; killing would risk taking
        // down another session's sidecar.
        const priorPpid = getProcessPpid(priorPid);
        if (priorPpid !== process.pid) {
          livenessLog("prior-owned-by-other", { priorPid, priorPpid });
          return null;
        }
      }

      const killed = __testing.killPriorSidecar(priorPid);
      if (!killed) {
        livenessLog("kill-failed-abort", { priorPid });
        return null;
      }
    }

    try {
      fs.unlinkSync(join(tDir, "shutdown"));
    } catch (e: any) {
      if (e && e.code !== "ENOENT") {
        livenessLog("shutdown-unlink-failed", { code: e.code });
        return null;
      }
    }

    let child;
    try {
      child = spawn(
        process.execPath,
        ["-e", SIDECAR_SCRIPT, tDir, String(intervalMs), SIDECAR_ARGV_MARKER],
        { stdio: "ignore" }
      );
    } catch (e: any) {
      livenessLog("spawn-threw", { code: e?.code });
      return null;
    }
    child.unref();
    const newPid = child.pid ?? null;

    if (newPid !== null) {
      try {
        writeSidecarPid(tDir, newPid);
        spawned = { pid: newPid, terminate: () => terminateChild(child, newPid) };
      } catch (e: any) {
        livenessLog("write-pid-failed", { code: e?.code, newPid });
        // We hold the handle for this child, so stop it through the handle
        // rather than by number. That also bypasses the signature gate, which
        // races the ps/proc table write for a freshly-forked child, without
        // the risk of signalling a number the OS may have reassigned (ISS-930).
        terminateChild(child, newPid);
        return null;
      }
    }
    return spawned;
  } finally {
    releaseSpawnLock(handle);
  }
}

export function spawnAliveSidecar(tDir: string, intervalMs = 10_000): number | null {
  return spawnAliveSidecarChild(tDir, intervalMs)?.pid ?? null;
}

export function killSidecar(pid: number | undefined | null): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ESRCH or similar - process already dead
  }
}

export function writeShutdownMarker(sessionDir: string): void {
  const tDir = telemetryDirPath(sessionDir);
  try {
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(join(tDir, "shutdown"), "1");
    fs.writeFileSync(join(tDir, "alive"), "0");
    unlinkSidecarPid(tDir);
  } catch {
    // best-effort
  }
}

const _knownTelemetryDirs = new Set<string>();

export function touchLastMcpCallFile(sessionDir: string): void {
  const tDir = telemetryDirPath(sessionDir);
  const target = join(tDir, "lastMcpCall");
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    if (!_knownTelemetryDirs.has(tDir)) {
      fs.mkdirSync(tDir, { recursive: true });
      _knownTelemetryDirs.add(tDir);
    }
    fs.writeFileSync(tmp, new Date().toISOString());
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function readLastMcpCall(sessionDir: string): string | null {
  try {
    return (
      fs.readFileSync(join(telemetryDirPath(sessionDir), "lastMcpCall"), "utf-8").trim() || null
    );
  } catch {
    return null;
  }
}

function readAliveTimestampIn(tDir: string): number | null {
  if (fs.existsSync(join(tDir, "shutdown"))) return null;
  try {
    const val = fs.readFileSync(join(tDir, "alive"), "utf-8").trim();
    const n = Number(val);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function readAliveTimestamp(sessionDir: string): number | null {
  return readAliveTimestampIn(telemetryDirPath(sessionDir));
}

// ---------------------------------------------------------------------------
// Heartbeat generations (T-450 step 3)
// ---------------------------------------------------------------------------

/**
 * WHY TELEMETRY IS GENERATION-SCOPED.
 *
 * Two failures share one cause, that every owner in turn writes to a single
 * telemetry directory. A failed `spawnAliveSidecar` does not leave the session
 * byte-identical: before returning null it can create and chmod telemetry, kill
 * a prior sidecar, unlink the shutdown marker, spawn a child and rewrite
 * `sidecar.pid`. Worse in the other direction, a SUCCESSFUL spawn followed by a
 * failed commit leaves a heartbeat produced by the RECOVERING caller attached
 * to the still-OLD owner, which suppresses that session's recovery for good.
 *
 * So a recovery STAGES its heartbeat in a generation-specific directory, and
 * the generation id is published only in the same atomic postimage as
 * `ownerTask`. A staged generation nothing published is invisible to every
 * reader, so a failed commit suppresses nothing, and a marker written by an
 * older generation is not consulted at all, so it cannot corroborate after the
 * server that wrote it has gone.
 *
 * A session with no recorded generation keeps using the legacy directory
 * unchanged. That is the compatibility arm, and it is why this ships with no
 * caller: nothing writes a generation yet, so nothing on disk today changes.
 */
const GENERATIONS_DIRNAME = "generations";
const GENERATION_ID_PATTERN = new RegExp(`^${CROCKFORD_CLASS}{16}$`);
const READINESS_TIMEOUT_MS = 5_000;
const READINESS_POLL_MS = 25;
/** Ceilings for caller-supplied waits. A bounded wait that is not bounded is a hang. */
const READINESS_TIMEOUT_MAX_MS = 60_000;
const READINESS_POLL_MAX_MS = 1_000;

/**
 * A caller-supplied duration, normalized before anything waits on it.
 *
 * Non-finite values are REFUSED rather than passed through, because both of
 * them defeat the bound they are supposed to set. `Date.now() + NaN` is NaN and
 * every comparison against NaN is false, so a NaN timeout produces a readiness
 * loop with no reachable deadline; `sleepMs(Infinity)` parks the synchronous
 * caller inside `Atomics.wait` and never returns. Either one turns a bounded
 * wait into an indefinite hang of the process that asked for the wait.
 *
 * A negative value is clamped rather than refused: asking for no wait at all is
 * coherent, and the poll floor keeps that from becoming a spin.
 */
function durationOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(min, value), max);
}

/**
 * The window between creating a staged generation and re-checking where it
 * landed. Exposed on `__testing` for the same reason `fsApi` and `probeApi`
 * are: the re-check defends against a swap inside a window no test can
 * otherwise reach, and a defence nothing can exercise is a defence nobody
 * knows still works.
 */
const stagingHooks = {
  at: (_stage: "before-parent" | "before-create" | "created" | "before-spawn" | "before-remove" | "before-unlink", _path: string): void => {},
  /**
   * The spawn, seamed MODULE-PRIVATELY.
   *
   * Deliberately not a public option. Cleanup stops the child through the
   * capability the spawn returns, so a caller able to supply that spawn could
   * hand staging a process it never created and have it terminated on failure.
   * The seam exists for tests, which is why it lives here and not on the
   * exported options.
   */
  spawn: null as null | ((dir: string, intervalMs: number) => StagedChild | null),
  /** Test-only: issue a handle that is not frozen, to prove cleanup ignores its fields. */
  freezeHandles: true,
};

export type TelemetryUnusableReason =
  | "malformed-generation-id"
  | "generation-escapes-telemetry"
  /** A component exists but could not be canonicalized, so containment is unproven. */
  | "generation-path-unresolvable";

export type TelemetryLocation =
  | { readonly kind: "legacy"; readonly dir: string }
  | { readonly kind: "generation"; readonly dir: string; readonly id: string }
  | { readonly kind: "unusable"; readonly reason: TelemetryUnusableReason };

/**
 * A fresh, opaque generation id.
 *
 * Internally generated and never derived from anything a caller supplied,
 * because persisting one makes session state select a DIRECTORY. Same alphabet
 * and length as the ledger's canonical ids, reusing that encoder rather than
 * growing a second one.
 */
export function newHeartbeatGenerationId(): string {
  return encodeBase32Crockford(randomBytes(10));
}

type RealPath =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolvable" };

/**
 * Canonicalize, distinguishing "not there" from "could not tell".
 *
 * Collapsing the two is a fail-open: an existing component that cannot be
 * resolved because of EACCES, EIO, or a dangling link would read as absent,
 * and absent is the arm that skips the containment proof.
 */
function realPath(path: string): RealPath {
  try {
    return { kind: "resolved", path: fsApi.realpathSync(path) };
  } catch (e: any) {
    if (!e || e.code !== "ENOENT") return { kind: "unresolvable" };
    // ENOENT from `realpath` has two causes, and only one of them is "nothing
    // is there". A DANGLING symlink also reports ENOENT while the path very
    // much exists, and treating that as absent would skip the containment
    // proof for a component that is already a link to somewhere else.
    try {
      fsApi.lstatSync(path);
      // It exists, as a link that goes nowhere.
      return { kind: "unresolvable" };
    } catch (inner: any) {
      // And the confirming call gets the same three-state treatment as the
      // first one. An EACCES or EIO here means we could not tell whether the
      // path exists, which is not the same as knowing it does not.
      return inner && inner.code === "ENOENT" ? { kind: "absent" } : { kind: "unresolvable" };
    }
  }
}

/**
 * Where to read this session's telemetry, or a refusal.
 *
 * THE ID IS A PATH SELECTOR, so it is treated as one. `.story/` is
 * corruption-resistant rather than forgery-resistant, and that posture is fine
 * for a value that is merely read. It is not fine for a value that selects a
 * directory whose cleanup KILLS PROCESSES and REMOVES FILES, so this is
 * stricter than "parse it": the pattern admits no separators, no dots and no
 * absolute paths, and the resolved real path must still be the one we expect.
 *
 * The symlink check cannot be done lexically. An impeccable id can name a
 * directory that is a link somewhere else entirely, and following it would read
 * evidence from outside the session. It is done on the REAL paths of both
 * sides, so a session reached through a symlinked path (every project under
 * /tmp on macOS) is unaffected: what matters is where the generation lands,
 * not how the session directory was reached.
 */
export function resolveTelemetryLocation(
  sessionDir: string,
  // `unknown`, not `string | null`, because this reads a PERSISTED value. A
  // caller that narrows first has to decide what a number or an object means,
  // and the only safe answer is the one made here: anything that is not a
  // valid id is a refusal, never a fallback to the legacy directory.
  generationId?: unknown,
): TelemetryLocation {
  const root = telemetryDirPath(sessionDir);

  // ONLY a genuinely absent value takes the legacy arm. Not the empty string:
  // no session written before this feature carries the field at all, so a
  // present-but-empty value is damage, and treating it as "no generation"
  // would point a generation-bearing session at the previous owner's
  // telemetry, which is the exact confusion generations exist to end.
  if (generationId === undefined || generationId === null) {
    return { kind: "legacy", dir: root };
  }
  if (typeof generationId !== "string" || !GENERATION_ID_PATTERN.test(generationId)) {
    return { kind: "unusable", reason: "malformed-generation-id" };
  }

  // THE PARENT IS CHECKED TOO, and checking only the leaf is the bug this
  // exists to avoid: with the leaf absent, its realpath is null, so a
  // `generations` directory that is itself a symlink out of the tree would be
  // accepted and staging would then create files at the far end of it.
  const realRoot = realPath(root);
  if (realRoot.kind === "unresolvable") {
    return { kind: "unusable", reason: "generation-path-unresolvable" };
  }
  const parent = join(root, GENERATIONS_DIRNAME);
  const contained = (component: RealPath, expected: string): TelemetryUnusableReason | null => {
    if (component.kind === "absent") return null;
    if (component.kind === "unresolvable") return "generation-path-unresolvable";
    // An existing component with no resolvable root cannot be proven contained.
    if (realRoot.kind !== "resolved") return "generation-escapes-telemetry";
    return component.path === expected ? null : "generation-escapes-telemetry";
  };

  const parentFault = contained(
    realPath(parent),
    realRoot.kind === "resolved" ? join(realRoot.path, GENERATIONS_DIRNAME) : "",
  );
  if (parentFault) return { kind: "unusable", reason: parentFault };

  const dir = join(parent, generationId);
  const leafFault = contained(
    realPath(dir),
    realRoot.kind === "resolved" ? join(realRoot.path, GENERATIONS_DIRNAME, generationId) : "",
  );
  if (leafFault) return { kind: "unusable", reason: leafFault };

  // A generation that does not exist yet is contained by construction, since a
  // pattern-checked id cannot leave the directory it is joined onto and the
  // ancestors it would pass through have just been checked.
  return { kind: "generation", dir, id: generationId };
}

/**
 * The handles staging actually produced, mapped to what cleanup may act on.
 *
 * A CAPABILITY, not a shape, defended at two levels that do different jobs.
 * The private field makes the type nominal, so ordinary callers cannot build a
 * compile-time-valid handle at all; that stops honest mistakes. It does not
 * stop casts or plain JavaScript, which can still fabricate a lookalike with a
 * valid id, the derived path and any pid it likes, and checking that its fields
 * agree with one another proves only that the caller could do the arithmetic.
 * Membership here is the RUNTIME authority, and the only thing that establishes
 * provenance.
 *
 * A MAP rather than a set, because `readonly` is a compile-time fiction: the
 * holder of a genuine handle can still assign to its fields and would otherwise
 * be signalling an arbitrary pid or deleting an arbitrary directory through a
 * capability it legitimately owns. Cleanup therefore reads the record stored
 * here and never the object it was handed. Discard CONSUMES the entry, so a
 * handle cannot be replayed against a pid that has since been recycled.
 *
 * Weak so a dropped handle does not leak the MAP ENTRY. That is the only thing
 * it saves, and it is worth being exact: a caller that drops its sole handle
 * without discarding can no longer clean up at all, so the staged child keeps
 * running and its directory stays on disk. Every unpublished handle must be
 * retained and discarded.
 */
const stagedHandles = new WeakMap<StagedHeartbeatGeneration, StagedRecord>();

/**
 * Is this still a path underneath the session's own generations directory?
 *
 * Re-derived from the real filesystem rather than trusted from earlier, because
 * the thing being defended against is precisely that an ancestor changed since
 * then. A parent replaced by a symlink resolves somewhere else, so the compare
 * fails and the caller declines. Unresolvable on either side is also a decline:
 * cleanup is the wrong place to guess.
 */
function stillInsideTelemetry(sessionDir: string, dir: string): boolean {
  // The expected path is BUILT from the resolved telemetry root, never resolved
  // through the generations component itself. Resolving both sides would follow
  // the same replaced link on each and compare a path against itself, which is
  // the tautology this whole guard exists to avoid.
  const root = realPath(telemetryDirPath(sessionDir));
  if (root.kind !== "resolved") return false;
  const parent = realPath(join(dir, ".."));
  return parent.kind === "resolved" && parent.path === join(root.path, GENERATIONS_DIRNAME);
}

/**
 * Re-check identity AND containment, then attempt bounded removal.
 *
 * Not "remove only the validated directory", which would claim more than any
 * path-based code can deliver: a final check-to-use window remains between the
 * containment proof and the syscalls, and ISS-931 records why it cannot be
 * closed here. The bounded removal is what makes losing that window survivable.
 */
function removeIfStillOurs(dir: string, identity: string, sessionDir: string): void {
  if (directoryIdentityOf(dir) !== identity) {
    livenessLog("generation-cleanup-not-ours", { dir });
    return;
  }
  // The seam is the window: anything a concurrent writer does to this path can
  // be landed here by a test.
  stagingHooks.at("before-remove", dir);
  // Containment is re-proven as LATE as it can be, so a swap that persists to
  // this moment is caught outright instead of being raced. What remains after
  // this line is a check-to-use sliver that no path-based API can remove, and
  // the bounded removal below is what makes losing that sliver survivable.
  if (!stillInsideTelemetry(sessionDir, dir)) {
    livenessLog("generation-cleanup-escaped", { dir });
    return;
  }
  // THE RESIDUAL, and it is not closable from here. Between the proof above and
  // the syscalls below the parent can change again, and no further path-based
  // recheck helps: each one just moves the same window. Deferring cleanup to a
  // collector does not help either, because a collector must also unlink by
  // path and inherits exactly this window. Only handle-relative primitives
  // (openat/unlinkat) close it, and Node exposes none.
  //
  // So the residual is bounded rather than eliminated, and the bound is what
  // makes it acceptable: cleanup unlinks only the names this feature writes and
  // never recurses, so losing this race costs at most those named files in a
  // directory that is not ours. It cannot cost a subtree. ISS-931 tracks the
  // real closure. The seam exists so this exact window is covered by a test
  // instead of being described in a comment nobody can verify.
  stagingHooks.at("before-unlink", dir);
  removeGenerationDir(dir);
}

/**
 * A generation that exists on disk and has acknowledged a heartbeat, but that
 * nothing has published.
 *
 * RETAIN THIS BY REFERENCE. It is a capability, not a value: the private field
 * means a spread, a clone or a serialization round-trip is not this type, so
 * copying it is a compile error rather than a puzzle at runtime. Its public
 * fields are informational; nothing in cleanup reads them.
 *
 * Only the TYPE is exported. The class itself is module-private and so is the
 * one function that issues instances, because an exported factory would hand
 * every caller a way to mint a compile-time-valid handle and reduce the private
 * field to decoration. Staging is the only issuer there is.
 */
class StagedHeartbeatGenerationImpl {
  /** Excluded from structural typing, which is the entire point of it. */
  readonly #issued: true = true;

  constructor(
    readonly id: string,
    readonly dir: string,
    readonly sessionDir: string,
    readonly pid: number,
    readonly identity: string,
  ) {}

  /** True for every instance; exists so the private field is not dead weight. */
  get issued(): boolean {
    return this.#issued;
  }
}

export type StagedHeartbeatGeneration = StagedHeartbeatGenerationImpl;

function issueStagedGeneration(
  id: string,
  dir: string,
  sessionDir: string,
  pid: number,
  identity: string,
): StagedHeartbeatGeneration {
  return new StagedHeartbeatGenerationImpl(id, dir, sessionDir, pid, identity);
}

/** What cleanup actually acts on. Never reachable from the handle's holder. */
interface StagedRecord {
  readonly dir: string;
  readonly identity: string;
  /** For the containment re-proof at cleanup time. Never read off the handle. */
  readonly sessionDir: string;
  /** The exact child, not its number. */
  readonly child: StagedChild;
}

export interface StageGenerationOptions {
  readonly intervalMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly pollMs?: number;
}

/**
 * A NON-NULL SPAWN IS NOT READINESS.
 *
 * An earlier draft treated a returned pid as proof of a heartbeat and, when the
 * child died before its first tick, relied on a later takeover being refused.
 * That is the wrong outcome: the generation stays permanently `undetermined`,
 * so the owner this recovery just bound has no usable heartbeat and can never
 * itself be recovered through this feature. It converts a live-owner false
 * positive into a permanently unrecoverable session, which is a different
 * failure and not a safer one.
 *
 * So publication requires an acknowledgement within a bounded wait: a first
 * heartbeat in the staged generation, and a staged pid still carrying the
 * sidecar signature. The directory is created here and only that child writes
 * into it, so a heartbeat appearing in it is that child's.
 */
function acknowledgeReadiness(dir: string, pid: number, timeoutMs: number, pollMs: number): boolean {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    // Deliberately NOT sticky. `readAliveTimestampIn` returns null once a
    // shutdown marker appears, so remembering an earlier tick would let the
    // deadline arm accept a generation whose own telemetry now says it stopped.
    // Readiness is a claim about the current state, not about a state that once
    // held.
    const heartbeat = readAliveTimestampIn(dir) !== null;
    const signature = probeApi.probeArgvSignature(pid, [SIDECAR_ARGV_MARKER]);

    // Both halves proven: a heartbeat we can see, written by a process that is
    // still the sidecar we spawned.
    if (heartbeat && signature === "match") return true;

    // A definitively dead child is an ANSWER, not something to keep waiting on.
    // Waiting out the full timeout on a process that is provably gone buys
    // nothing and delays every recovery attempt by that much.
    if (signature === "absent") return false;

    if (Date.now() >= deadline) {
      // DEGRADED ACCEPTANCE, and the alternative is worse. "unknown" means the
      // argv probe could not answer (a `ps` failure, an unsupported platform),
      // never that the process is gone; requiring "match" here would make
      // staging fail permanently wherever argv inspection is unavailable, so
      // the feature could never recover a session on that platform at all.
      // A heartbeat is direct evidence that the staged child ran and wrote, so
      // it is accepted alone only after the probe has been given the whole
      // window to answer and never once said "absent".
      if (heartbeat) livenessLog("generation-readiness-degraded", { pid });
      return heartbeat;
    }
    // Seamed so a regression cannot HANG the suite that is meant to catch it.
    // An unnormalized poll blocks inside `Atomics.wait`, which holds the event
    // loop, so no test timer could ever fire to report the failure; the test
    // would present as an outer job timeout with no indication of which case
    // broke. The seam lets a test observe the value and cap the iterations.
    timeApi.sleepMs(pollMs);
  }
}

/**
 * Stage a generation and prove it heartbeats, or refuse and attempt bounded
 * cleanup. Not "leave nothing behind": cleanup declines whenever it cannot
 * re-prove containment, and a leaf created inside a parent that was swapped
 * before the create is deliberately LEAKED rather than deleted through a path
 * this code cannot vouch for. Leaking is the intended failure direction.
 *
 * Returns a handle the caller publishes ATOMICALLY alongside `ownerTask`, or
 * null. Nothing here writes session state: staging is not publication, and a
 * handle that is never published is invisible to every reader.
 */
export function stageHeartbeatGeneration(
  sessionDir: string,
  options: StageGenerationOptions = {},
): StagedHeartbeatGeneration | null {
  const id = newHeartbeatGenerationId();
  if (resolveTelemetryLocation(sessionDir, id).kind !== "generation") return null;

  // Create the parent SEPARATELY and prove it is a real directory before
  // creating anything beneath it. `mkdirSync(recursive)` happily succeeds when
  // a component is a symlink to an existing directory, so creating the leaf in
  // one call would follow such a link and write outside the session.
  const parent = join(telemetryDirPath(sessionDir), GENERATIONS_DIRNAME);
  stagingHooks.at("before-parent", parent);
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    // lstat, so a symlink is not a directory.
    if (!fs.lstatSync(parent).isDirectory()) {
      livenessLog("generation-parent-not-a-directory", {});
      return null;
    }
  } catch (e: any) {
    livenessLog("generation-mkdir-failed", { code: e?.code });
    return null;
  }
  const dir = join(parent, id);
  stagingHooks.at("before-create", dir);
  try {
    // NON-recursive on purpose: an existing leaf, including a symlink someone
    // put there, throws EEXIST rather than being silently adopted or followed.
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e: any) {
    livenessLog("generation-mkdir-failed", { code: e?.code });
    return null;
  }
  stagingHooks.at("created", dir);

  // WHAT THE BRACKET BELOW DOES AND DOES NOT BUY.
  //
  // Every check here is check-then-use: the parent can be swapped between its
  // lstat and the leaf's creation, and the leaf between its validation and the
  // spawn. Closing those windows properly needs no-follow directory handles
  // (openat/mkdirat), which Node does not expose, so it would take a native
  // addon. That is disproportionate to the threat this module documents:
  // `.story/` is corruption-resistant, not forgery-resistant, and a process
  // that can swap directories inside the user's own project can equally well
  // edit the state file or run the admin CLI.
  //
  // So the windows are narrowed rather than eliminated, in the same shape used
  // elsewhere in this feature: identify the validated directory by `dev:ino`
  // and re-check that identity before anything is published. A concurrent
  // recreation is caught; a determined adversary with write access is not the
  // subject.
  const identity = directoryIdentityOf(dir);
  const location = resolveTelemetryLocation(sessionDir, id);
  if (identity === null || location.kind !== "generation" || location.dir !== dir) {
    livenessLog("generation-escaped-after-create", { id, reason: location.kind === "unusable" ? location.reason : "leaf-not-ours" });
    // This is the one cleanup site whose identity cannot be a real guard: it was
    // read from the same path a moment ago, so comparing it re-reads the same
    // directory and matches itself. That is worth stating plainly rather than
    // dressing up, and an earlier version of this code did dress it up.
    //
    // What makes the removal safe anyway is that cleanup is BOUNDED: it unlinks
    // only the names this feature writes and then removes the directory only if
    // that left it empty. So the worst outcome when the parent was swapped and
    // this path now resolves somewhere foreign is that a directory keeping a
    // file called `alive` or `shutdown` loses it. It cannot lose a subtree.
    // The alternative, removing nothing, is not free either: a parent swapped
    // BEFORE the create leaves our own fresh leaf sitting inside somebody
    // else's directory, so refusing to clean up trades destroying foreign data
    // for littering in it.
    if (identity !== null) removeIfStillOurs(dir, identity, sessionDir);
    return null;
  }
  stagingHooks.at("before-spawn", dir);
  if (directoryIdentityOf(dir) !== identity) {
    livenessLog("generation-swapped-before-spawn", { id });
    return null;
  }

  const spawnSidecar = stagingHooks.spawn ?? spawnAliveSidecarChild;
  let child: StagedChild | null;
  try {
    child = spawnSidecar(dir, options.intervalMs ?? 10_000);
  } catch (e: any) {
    // The real spawn can throw from lock setup or an unexpected filesystem
    // error. Escaping here would break the null-on-failure contract AND leave
    // the staged directory behind for a generation nobody will ever publish.
    livenessLog("generation-spawn-threw", { code: e?.code });
    removeIfStillOurs(dir, identity, sessionDir);
    return null;
  }
  if (child === null) {
    removeIfStillOurs(dir, identity, sessionDir);
    return null;
  }
  const pid = child.pid;

  const issued = issueStagedGeneration(id, dir, sessionDir, pid, identity);
  // The cast is the brand working as intended: `Object.freeze` returns
  // `Readonly<T>`, which drops the private field, so even the freeze cannot
  // launder a value into this type without saying so.
  const staged = (stagingHooks.freezeHandles ? Object.freeze(issued) : issued) as StagedHeartbeatGeneration;
  stagedHandles.set(staged, { dir, identity, sessionDir, child });
  const timeoutMs = durationOption(options.readinessTimeoutMs, READINESS_TIMEOUT_MS, 0, READINESS_TIMEOUT_MAX_MS);
  const pollMs = durationOption(options.pollMs, READINESS_POLL_MS, 1, READINESS_POLL_MAX_MS);
  if (!acknowledgeReadiness(dir, pid, timeoutMs, pollMs)) {
    livenessLog("generation-readiness-failed", { pid });
    stagedHandles.delete(staged);
    child.terminate();
    removeIfStillOurs(dir, identity, sessionDir);
    return null;
  }
  // The heartbeat we just accepted has to have been written in the directory we
  // validated, not in whatever now sits at that path.
  if (directoryIdentityOf(dir) !== identity) {
    livenessLog("generation-swapped-during-readiness", { id });
    discardStagedGeneration(staged);
    return null;
  }
  return staged;
}

/** `dev:ino` for a real directory, or null. bigint because an inode need not fit a double. */
function directoryIdentityOf(dir: string): string | null {
  try {
    const stat = fs.lstatSync(dir, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * The fixed member names in a generation directory. Not the whole set cleanup
 * recognizes: the lock's `sidecar.lock.tmp.*` temporaries carry a pid and a
 * timestamp, so they are matched by prefix separately rather than listed here.
 */
const GENERATION_MEMBERS = ["alive", "shutdown", "lastMcpCall", PID_BASENAME, LOCK_BASENAME];

/**
 * Remove a generation directory by NAME, never recursively.
 *
 * Recursion is what turns a lost race into data loss. Every identity check in
 * this file is check-then-use against a path, and no path-based API can close
 * that window: the parent can be replaced between the check and the syscall,
 * and `mkdirat`/`openat`, which would close it, are not exposed by Node. So
 * rather than depend on winning the race, cleanup is made incapable of the
 * harm. It unlinks only the names this feature itself writes and then removes
 * the directory only if that left it EMPTY.
 *
 * A directory that turns out not to be ours therefore loses, at worst, files
 * named exactly `alive`, `shutdown`, `lastMcpCall`, `sidecar.pid`,
 * `sidecar.lock` or a `sidecar.lock.tmp.*` temporary, and survives entirely if
 * it holds anything else. The cost is
 * that an unexpected member leaks the directory rather than deleting it, which
 * is the correct direction to fail and is logged.
 */
function removeGenerationDir(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!GENERATION_MEMBERS.includes(name) && !name.startsWith(`${LOCK_BASENAME}.tmp.`)) continue;
      try { fs.unlinkSync(join(dir, name)); } catch { /* already gone, or not a file */ }
    }
    fs.rmdirSync(dir);
  } catch (e: any) {
    livenessLog("generation-cleanup-failed", { code: e?.code });
  }
}

/**
 * Stop a staged generation's child and attempt bounded removal of its
 * directory. Removal is best-effort by design: it declines if containment
 * cannot be re-proven, unlinks only the names this feature writes, and leaves
 * the directory in place if that did not empty it.
 *
 * Accepts ONLY the exact capability staging issued, consumes it, and acts on
 * the record stored against it. Nothing here reads a field off the object it
 * was handed: the child is stopped through the capability the spawn returned,
 * never through a pid read off the handle. That takes the handle's fields out
 * of the decision. It does not make Node stop signalling the stored pid. A
 * discard arriving long after the sidecar died is ordinarily fine, because by
 * then the exit is reflected in the child's fields and nothing is signalled;
 * the window ISS-930 tracks is narrower than that, and needs the discard to run
 * inside the libuv batch-reap interval before those fields are updated.
 */
export function discardStagedGeneration(staged: StagedHeartbeatGeneration): void {
  const record = stagedHandles.get(staged);
  if (!record) {
    livenessLog("generation-discard-refused", {});
    return;
  }
  stagedHandles.delete(staged);

  // Unconditional for the CHILD: leaving it running orphans a sidecar
  // heartbeating into a generation nobody will publish.
  record.child.terminate();

  // Conditional for the DIRECTORY. If it was replaced while readiness was
  // being acknowledged, what sits there now belongs to whatever concurrent
  // operation put it there.
  removeIfStillOurs(record.dir, record.identity, record.sessionDir);
}

// ---------------------------------------------------------------------------
// Owner-gone CANDIDATE evidence (T-450)
// ---------------------------------------------------------------------------

/**
 * WHAT THIS IS NOT: a determination that an owner task is dead.
 *
 * That determination is not available from anything on disk (ISS-926). The
 * alive sidecar watches `process.ppid` and is spawned by the MCP SERVER, so it
 * reports server death, not owner-task death; an ordinary MCP restart produces
 * the identical marker while the owner task lives on. The only owner-task-bound
 * signal is `lastGuideCall`, and guide calls happen at workflow-state
 * transitions, so a healthy session in IMPLEMENT lapses for many minutes. Read
 * together, those two can BOTH read "gone" for a fully live owner, and no
 * threshold repairs it because they measure different subjects.
 *
 * So this returns CANDIDATE evidence and nothing stronger. The machine decides
 * only whether to OFFER a recovery; a human decides whether to act, and the
 * typed confirmation is the authority. Every consumer must present the signals
 * separately, with timestamps, and say what could not be verified. No caller
 * may render any of this as "the owner is dead".
 *
 * TRUST MODEL: these are ordinary workspace files, writable by any process
 * running as this user. Reading them here rather than trusting a caller's
 * assertion buys resistance to ACCIDENT, not to forgery, which is the same
 * posture SKILL.md already documents for task identity. A process that can
 * forge these can also run the admin CLI, so the threat model is unchanged.
 * The hardened reads below are corruption resistance, not authentication.
 */
export type OwnerActivitySignal =
  | { readonly kind: "fresh"; readonly at: string; readonly ageMs: number }
  | { readonly kind: "stale"; readonly at: string; readonly ageMs: number }
  | { readonly kind: "unknown"; readonly reason: "absent" | "unparseable" | "future" };

export type DeathMarkerSignal =
  | { readonly kind: "shutdown-marker"; readonly at: string | null }
  | { readonly kind: "alive-zero"; readonly at: string }
  | { readonly kind: "none"; readonly aliveAt: number }
  | {
      readonly kind: "unreadable";
      readonly reason:
        | "absent"
        | "non-numeric"
        | "future"
        | "raced"
        | "no-marker-time"
        // The session names a heartbeat generation we will not read from. Kept
        // DISTINCT from "absent", which is an observation: this is a refusal to
        // look, and collapsing the two would let a refusal corroborate.
        | TelemetryUnusableReason;
    };

export type MarkerValiditySignal =
  | {
      readonly kind: "invalidated";
      readonly reason: "recorded-mcp-pid-alive" | "superseded-by-owner-identity";
      readonly pid: number;
      /** Display and audit only (ruling C-2). Never read by the predicate. */
      readonly recordedAt: string | null;
      readonly successorPids?: readonly number[];
    }
  /** The recorded server pid is DEFINITIVELY gone (ESRCH). The only arm that may corroborate. */
  | { readonly kind: "not-invalidated"; readonly pid: number; readonly recordedAt: string | null }
  | {
      readonly kind: "unknown";
      readonly reason:
        | "no-recorded-pid"
        | "pid-probe-failed"
        | "successors-unavailable"
        | "owner-identity-unrecorded"
        | "successor-identity-unknown";
      readonly pid: number | null;
    };

export type SidecarProbeSignal =
  | { readonly kind: "match"; readonly pid: number }
  | { readonly kind: "absent"; readonly pid: number }
  | {
      readonly kind: "unknown";
      readonly reason: "no-pid" | "probe-unknown" | TelemetryUnusableReason;
      readonly pid: number | null;
    };

/**
 * Lease state, captured HERE rather than read separately later.
 *
 * Ruling B requires the confirmation prompt to present lease state alongside
 * the rest of the evidence. Reading it at render time would produce a
 * different-time snapshot and quietly falsify the claim that this object is a
 * single coherent observation.
 */
export type LeaseSignal =
  | { readonly kind: "live"; readonly expiresAt: string; readonly remainingMs: number }
  | { readonly kind: "expired"; readonly expiresAt: string; readonly agoMs: number }
  | { readonly kind: "unknown"; readonly reason: "absent" | "unparseable" };

export interface OwnerLivenessSignals {
  readonly activity: OwnerActivitySignal;
  readonly lease: LeaseSignal;
  readonly deathMarker: DeathMarkerSignal;
  readonly markerValidity: MarkerValiditySignal;
  readonly sidecarProbe: SidecarProbeSignal;
  readonly observedAt: string;
  readonly staleThresholdMs: number;
  readonly successors: SuccessorServers;
}

/**
 * A digest of WHAT WAS OBSERVED, deliberately independent of WHEN (T-450).
 *
 * This exists to answer one question inside the recovery lock: did the picture
 * the human was shown change between being shown it and confirming it? It is
 * NOT the eligibility check. Whether the owner is still stale RIGHT NOW is a
 * separate re-evaluation against the current clock, and keeping the two apart
 * is the whole point.
 *
 * WHY TIME IS EXCLUDED, stated because the obvious implementation is wrong.
 * A first design folded `observedAt` and the computed ages into the digest and
 * then required an exact match against a recomputation. That can never match:
 * recomputing a moment later necessarily produces a different observation time,
 * so every legitimate confirmation would be rejected while nothing had actually
 * changed.
 *
 * The subtler half is that several fields which LOOK like observations are
 * really verdicts about the clock. `activity.kind` flips `fresh` to `stale`
 * with nothing but elapsed time, and `lease.kind` flips `live` to `expired` the
 * same way. Digesting either would reintroduce the same defect through a
 * different field. So the rule is: where a usable stored value exists, digest
 * the VALUE and not its fresh/stale or live/expired classification. Where no
 * usable value exists, the REASON is digested (see the `future` note below).
 *
 * `staleThresholdMs` is excluded for the same reason it is safe to exclude: it
 * is policy, and a policy change is caught by the eligibility re-evaluation,
 * which recomputes the verdict under the current threshold.
 */
export function evidenceFingerprint(signals: OwnerLivenessSignals): string {
  const canonical = {
    // Only the stored timestamp, or the reason there is no usable one. The
    // `fresh` / `stale` classification is omitted: same value, different clock,
    // same picture. The `unknown` REASONS are kept, including `future`, because
    // they distinguish genuinely different pictures (no timestamp at all, an
    // unparseable one, and a clock-skewed one), and collapsing them would let
    // three different states confirm against each other. `future` is mildly
    // clock-dependent, since a future stamp eventually becomes an ordinary
    // past one. That is accepted rather than hidden: it surfaces as a
    // fingerprint mismatch, and the confirmation flow built on top of this is
    // REQUIRED to treat a mismatch by returning fresh evidence and asking for
    // re-confirmation rather than acting on a stale authorization. Nothing in
    // this function consumes the digest; that obligation belongs to the caller.
    activity: "at" in signals.activity
      ? { at: signals.activity.at }
      : { absent: signals.activity.reason },
    // Expiry only. `live` vs `expired` is the clock talking, not the ledger.
    lease: "expiresAt" in signals.lease
      ? { expiresAt: signals.lease.expiresAt }
      : { absent: signals.lease.reason },
    deathMarker: signals.deathMarker,
    // `successorPids` is built from a directory listing, so like `successors`
    // below it arrives in filesystem enumeration order. Normalizing one and not
    // the other would make the same evidence digest two different ways.
    markerValidity: signals.markerValidity.kind === "invalidated" && signals.markerValidity.successorPids
      ? { ...signals.markerValidity, successorPids: [...signals.markerValidity.successorPids].sort((a, b) => a - b) }
      : signals.markerValidity,
    sidecarProbe: signals.sidecarProbe,
    successors: signals.successors.kind === "observed"
      // Sorted: the registry is a directory listing, so enumeration order is a
      // filesystem detail and must not change the answer.
      ? {
          kind: "observed",
          servers: [...signals.successors.servers]
            // OUR OWN ENTRY IS EXCLUDED, and only here.
            //
            // The guide-call seam rewrites this server's entry whenever the
            // calling task id differs from the one recorded in it, stamping a
            // new identity and a fresh `registeredAt`. That is process-local
            // churn: it says nothing about the question this digest answers,
            // which is whether the set of OTHER live servers moved under a
            // human who confirmed a picture. Digesting it makes the handshake
            // self-invalidating, and one MCP server serving two tasks then
            // rejects the second task's first confirmation.
            //
            // Safe because it is scoped to the DIGEST. `readMarkerValidity`,
            // the rendered evidence and the eligibility recheck all still see
            // our entry, and `markerValidity` is itself digested below: if our
            // entry turns out to carry the OWNER's identity, the predicate
            // returns `superseded-by-owner-identity` naming our pid, that moves
            // the fingerprint, and the handshake fails as it must. Widening
            // this exclusion to `markerValidity` or `successorPids` would open
            // exactly the hole it is currently closing.
            .filter((s) => s.pid !== process.pid)
            // Identity is load-bearing since C-2, so it must be part of the
            // picture the human confirmed. registeredAt rides along as the
            // display value it now is.
            .map((s) => ({ pid: s.pid, identity: s.identity, registeredAt: s.registeredAt }))
            .sort((a, b) => a.pid - b.pid),
        }
      : signals.successors,
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

/** Key-order-independent JSON, so an object literal's shape cannot change the digest. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
}

/**
 * Exactly one of these permits an offer: `gone-candidate`. The other three are
 * distinct on purpose, because the message a caller owes the operator differs.
 *
 * - `active`        the owner acted recently. Never offer, whatever else says.
 * - `gone-candidate` activity lapsed AND a death marker survived invalidation.
 * - `contradicted`  a death marker exists but something live disagrees with it.
 *                   This is NOT `undetermined`: we HAVE evidence and it
 *                   conflicts, which is worth saying out loud.
 * - `undetermined`  evidence is missing or unreadable. `missing` names which.
 */
export type OwnerLivenessVerdict =
  | { readonly kind: "active"; readonly signals: OwnerLivenessSignals }
  | { readonly kind: "gone-candidate"; readonly signals: OwnerLivenessSignals }
  | { readonly kind: "contradicted"; readonly signals: OwnerLivenessSignals; readonly why: string }
  | { readonly kind: "undetermined"; readonly signals: OwnerLivenessSignals; readonly missing: readonly string[] };

/** The session fields this evidence is derived from. */
export interface OwnableLivenessState {
  /**
   * The telemetry generation this session's heartbeat lives in, if it has one.
   * Absent means the legacy directory, which is every session written before
   * this existed. Published only in the same atomic postimage as `ownerTask`.
   *
   * `unknown` deliberately. It arrives from a JSON file, and narrowing it at
   * the boundary would force each reader to decide what a number or an object
   * means; `resolveTelemetryLocation` decides once, and decides refusal.
   */
  readonly heartbeatGeneration?: unknown;
  readonly lastGuideCall?: string | null;
  readonly mcpServerPid?: number | null;
  readonly mcpGuideCallAt?: string | null;
  readonly lease?: { readonly expiresAt?: string | null } | null;
  /**
   * Whose session this is. Load-bearing since ruling C-2: succession is decided
   * by whether the OWNER's client is alive elsewhere, which is an identity
   * question, so the owner's identity is an input to the predicate rather than
   * decoration on the verdict.
   */
  readonly ownerTask?: OwnerTask | null;
}

/**
 * A PROVIDER, never a snapshot.
 *
 * A precomputed set cannot be re-read, so re-reading it before authorizing
 * returns the same object and the check is theatre. Accepting one would make
 * the final gate optional at exactly the authorization boundary, so the only
 * shape callers may pass is one that can actually answer twice.
 */
export type SuccessorSource = () => SuccessorServers;

/**
 * Session state, also a provider and for the same reason as the successor set.
 *
 * The owner can become active DURING an evaluation: a CLI `compact-prepare`
 * advances `lastGuideCall` without registering any successor, so a recheck that
 * looked only at the registry would still authorize from stale activity
 * evidence. Anything that can change under us has to be re-readable.
 */
export type LivenessStateSource = () => OwnableLivenessState;

/** The single predicate consumers gate the OFFER on. Never inline this test. */
export function permitsRecoveryOffer(v: OwnerLivenessVerdict): boolean {
  return v.kind === "gone-candidate";
}

/**
 * How long owner-task ACTIVITY must have lapsed before an owner-gone candidate
 * may even be considered.
 *
 * Deliberately NOT `ALIVE_FRESH_MS` (30s, in `waker.ts`), and deliberately not
 * derived from it. The two measure different subjects:
 *
 * - `ALIVE_FRESH_MS` is the alive FILE, rewritten every 10s by a sidecar whose
 *   parent is the MCP server. It answers "is a client process ticking".
 * - This is `lastGuideCall`, refreshed by `refreshLease` on the OWNER TASK's
 *   own guide calls. Those fire at workflow-state transitions, so a healthy
 *   session in IMPLEMENT running a test suite lapses for many minutes.
 *   Anything near 30s here would flag every working session.
 *
 * It lives in this module rather than beside `ALIVE_FRESH_MS` because `waker`
 * imports `liveness`, so the reverse import would be a cycle.
 *
 * Bounded on both sides: it must exceed the longest legitimate gap between
 * guide calls, and stay well under `LEASE_DURATION_MS` (45 min) or the band
 * this serves is empty, since `handleResume` already rebinds on expiry.
 *
 * A POLICY choice, not a derivation, which is why it is carried into every
 * evidence record as `staleThresholdMs`: a later change must show up in the
 * audit trail instead of silently reinterpreting past records.
 */
export const OWNER_STALE_MS = 10 * 60_000;

/**
 * What kind of process is this? THREE roles, not two, because collapsing the
 * last two is a fail-open.
 *
 * `mcpServerPid` is stamped inside `refreshLease`, which is the right seam for
 * keeping it consistent with its own timestamp but is NOT exclusively an MCP
 * path: `session compact-prepare` and the limit-stop flow call it from
 * short-lived CLI processes (`cli/commands/session-compact.ts:160`, `:1561`).
 *
 * - `cli`               not a server. Leaves any recorded pair untouched,
 *                       because recording a CLI pid would be worse than
 *                       recording nothing: it exits at once and its corpse then
 *                       reads as "this session's server is gone".
 * - `mcp-registered`    a server visible in the project registry. Stamps.
 * - `mcp-unregistered`  a server that is SERVING but could not register. It
 *                       must CLEAR the recorded pair, not preserve it.
 *                       Preserving would leave the pair naming a dead
 *                       predecessor while this live process stays invisible to
 *                       every other evaluator, which is exactly the evidence
 *                       one of them would use to authorize taking over a live
 *                       owner.
 */
export type McpProcessRole = "cli" | "mcp-registered" | "mcp-unregistered";

let processRole: McpProcessRole = "cli";

/** Called by the MCP server entry point after a CONFIRMED registry binding. */
export function markMcpServerProcess(): void { processRole = "mcp-registered"; }

/** Called by the MCP server entry point when registration failed. */
export function markMcpServerUnregistered(): void { processRole = "mcp-unregistered"; }

export function mcpProcessRole(): McpProcessRole { return processRole; }

/** The pid to stamp, or null when this process is not a registered server. */
export function currentMcpServerPid(): number | null {
  return processRole === "mcp-registered" ? process.pid : null;
}

/** Clock skew tolerance before a future-dated timestamp is treated as unusable. */
const FUTURE_SKEW_MS = 60_000;

function readActivity(lastGuideCall: string | null | undefined, now: number, staleMs: number): OwnerActivitySignal {
  if (!lastGuideCall) return { kind: "unknown", reason: "absent" };
  const t = new Date(lastGuideCall).getTime();
  if (Number.isNaN(t)) return { kind: "unknown", reason: "unparseable" };
  const ageMs = now - t;
  if (ageMs < -FUTURE_SKEW_MS) return { kind: "unknown", reason: "future" };
  return ageMs >= staleMs
    ? { kind: "stale", at: lastGuideCall, ageMs }
    : { kind: "fresh", at: lastGuideCall, ageMs };
}

function readLease(expiresAt: string | null | undefined, now: number): LeaseSignal {
  if (!expiresAt) return { kind: "unknown", reason: "absent" };
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return { kind: "unknown", reason: "unparseable" };
  return t > now
    ? { kind: "live", expiresAt, remainingMs: t - now }
    : { kind: "expired", expiresAt, agoMs: now - t };
}

function readDeathMarker(tDir: string, now: number): DeathMarkerSignal {
  try {
    const st = fs.statSync(join(tDir, "shutdown"));
    // A marker that is not a regular file, or whose mtime is implausible, is
    // not evidence. Only a readable regular file with a sane time counts.
    if (!st.isFile()) return { kind: "unreadable", reason: "non-numeric" };
    const t = st.mtime.getTime();
    if (Number.isNaN(t) || t - now > FUTURE_SKEW_MS) {
      return { kind: "unreadable", reason: "future" };
    }
    return { kind: "shutdown-marker", at: st.mtime.toISOString() };
  } catch (e: any) {
    // ONLY a genuinely absent marker falls through to the alive file. EACCES,
    // EIO, ELOOP and friends mean a marker may be there and we failed to read
    // it, which is absence of evidence, not evidence of absence.
    if (!e || e.code !== "ENOENT") return { kind: "unreadable", reason: "absent" };
  }

  // Stat, read, stat. The sidecar rewrites this file every 10s, so a bare
  // read-then-stat can pair zero CONTENT with the newer heartbeat's mtime and
  // still call it a death marker. Accepting only an unchanged snapshot makes
  // content and timestamp describe the same write.
  const p = join(tDir, "alive");
  let raw: string;
  let mtime: string | null = null;
  try {
    const before = fs.statSync(p);
    raw = fs.readFileSync(p, "utf-8").trim();
    const after = fs.statSync(p);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino) {
      return { kind: "unreadable", reason: "raced" };
    }
    mtime = after.mtime.toISOString();
  } catch { return { kind: "unreadable", reason: "absent" }; }

  // STRICT parsing, because `Number()` is far too permissive for evidence that
  // authorizes a destructive offer. `Number("")` is 0, so a file caught
  // mid-truncation by `writeFileSync` would manufacture a death marker out of
  // a concurrent write. Only the sidecar's exact literal counts.
  // A marker with no time cannot be presented as evidence (ruling B requires
  // the timestamp), so it must not be able to authorize anything either.
  if (raw === "0") {
    return mtime === null
      ? { kind: "unreadable", reason: "no-marker-time" }
      : { kind: "alive-zero", at: mtime };
  }
  if (!/^[0-9]+$/.test(raw)) return { kind: "unreadable", reason: "non-numeric" };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return { kind: "unreadable", reason: "non-numeric" };
  if (n - now > FUTURE_SKEW_MS) return { kind: "unreadable", reason: "future" };
  return { kind: "none", aliveAt: n };
}

function readMarkerValidity(
  mcpServerPid: number | null | undefined,
  successors: SuccessorServers,
  ownerTask: OwnerTask | null | undefined,
  recordedAtRaw: string | null | undefined,
): MarkerValiditySignal {
  if (!mcpServerPid || !Number.isInteger(mcpServerPid) || mcpServerPid <= 0) {
    return { kind: "unknown", reason: "no-recorded-pid", pid: null };
  }
  // Inert to this predicate (ruling C-2): nothing below this line reads it.
  // Succession is an identity question, and anchoring it on time is what let a
  // recovery client count itself as its own superseding successor. It is still
  // carried into the evidence so the confirmation prompt can show when the
  // recorded server was last serving, and it does reach `evidenceFingerprint`
  // from there, which is deliberate: inert to the PREDICATE is not the same as
  // absent from the picture a human confirmed.
  const recordedAt: string | null =
    recordedAtRaw && !Number.isNaN(new Date(recordedAtRaw).getTime()) ? recordedAtRaw : null;

  // (a) The recorded server itself. Strongest suppression, unchanged.
  //
  // No signature check, deliberately. A recycled pid reads as alive, which
  // SUPPRESSES the offer -- reuse points the safe way, so the cost of a
  // ps/proc lookup buys nothing here.
  try {
    probeApi.killProbe(mcpServerPid);
    return { kind: "invalidated", reason: "recorded-mcp-pid-alive", pid: mcpServerPid, recordedAt };
  } catch (e: any) {
    // EPERM means the pid exists under another uid. It cannot be our MCP
    // server, but something IS there, so treat it as alive and suppress.
    if (e && e.code === "EPERM") {
      return { kind: "invalidated", reason: "recorded-mcp-pid-alive", pid: mcpServerPid, recordedAt };
    }
    // Only ESRCH is a definitive "that process is gone". Anything else is a
    // probe that failed, which is absence of evidence, not evidence of
    // absence, and must not corroborate a death marker.
    if (!e || e.code !== "ESRCH") {
      return { kind: "unknown", reason: "pid-probe-failed", pid: mcpServerPid };
    }
  }

  // The recorded server is definitively gone. That is NOT yet enough: an
  // ordinary MCP restart produces exactly this, and the successor never touched
  // this session so nothing in its state mentions it. Ask the registry.
  if (successors.kind === "unavailable") {
    return { kind: "unknown", reason: "successors-unavailable", pid: mcpServerPid };
  }

  const others = successors.servers.filter((s) => s.pid !== mcpServerPid);

  // (b) IDENTITY MATCH is the only thing that supersedes (ruling C-2).
  //
  // The question is not "is some server newer than the dead one". Under that
  // reading every fresh client supersedes, including the recovery client doing
  // the evaluating, so the offer could never fire from anyone who arrived to
  // recover. The real question is whether the OWNER's client is alive right
  // now, somewhere other than the dead server. A live entry carrying the
  // owner's identity answers yes, and nothing else does.
  const matching = others.filter((s) => isSameOwnerTask(ownerTask ?? null, s.identity));
  if (matching.length > 0) {
    return {
      kind: "invalidated",
      reason: "superseded-by-owner-identity",
      pid: mcpServerPid,
      recordedAt,
      successorPids: matching.map((s) => s.pid),
    };
  }

  // (c) Cannot answer the identity question. Never `contradicted`: an
  // unattributable server COULD be the owner's, but "could be" is not positive
  // evidence of life, and asserting either way is the diagnosis-substitution
  // ruling A forbids. Ordered after (b) deliberately, so a definite match still
  // suppresses even when some other entry is unattributable.
  if (!ownerTask) {
    return { kind: "unknown", reason: "owner-identity-unrecorded", pid: mcpServerPid };
  }
  if (others.some((s) => s.identity === null)) {
    return { kind: "unknown", reason: "successor-identity-unknown", pid: mcpServerPid };
  }

  // (d) Every live entry is readable and belongs to somebody else, or there are
  // none at all. Succession does not invalidate; the marker and sidecar checks
  // decide, exactly as they would with an empty registry.
  return { kind: "not-invalidated", pid: mcpServerPid, recordedAt };
}

/**
 * Mutable indirection, same pattern as `fsApi` above and for the same reason.
 *
 * The `unknown` arm of the probe is the one that MUST never corroborate death,
 * and it is unreachable from on-disk fixtures: a dead pid probes `absent`, and
 * a live non-sidecar process probes `absent` too because its argv lacks the
 * markers. Producing a genuine `unknown` needs a live process whose argv cannot
 * be read, which a test cannot arrange portably. Without this seam a mutation
 * that collapses the tri-state survives the whole suite, which is exactly what
 * happened before it existed.
 */
const probeApi = {
  probeArgvSignature,
  /**
   * Liveness probe for the recorded MCP server pid. Seamed for the same reason
   * as the argv probe: EPERM and unexpected `kill` failures are the fail-closed
   * arms, and neither is reachable from a fixture, so a mutation collapsing
   * `pid-probe-failed` into definitive absence would otherwise survive.
   */
  killProbe: (pid: number): void => { process.kill(pid, 0); },
};

function readSidecarProbe(tDir: string): SidecarProbeSignal {
  const pid = readSidecarPid(tDir);
  if (pid === null) return { kind: "unknown", reason: "no-pid", pid: null };
  // The TRI-STATE probe, never `hasSidecarSignature`. That wrapper collapses
  // "unknown" to false, so a ps/proc failure or an unsupported platform would
  // read as proof of death -- inverting this function's own documented
  // contract ("do NOT report a live pid as absent").
  const byMarker = probeApi.probeArgvSignature(pid, [SIDECAR_ARGV_MARKER]);
  const probe = byMarker === "absent" ? probeApi.probeArgvSignature(pid, [SIDECAR_SENTINEL]) : byMarker;
  if (probe === "match") return { kind: "match", pid };
  if (probe === "absent") return { kind: "absent", pid };
  return { kind: "unknown", reason: "probe-unknown", pid };
}

/**
 * Gather every signal, then rule. Signals are ALWAYS fully populated, even when
 * the verdict is decided by the first one, because callers must render them all
 * (the confirmation prompt shows each separately with its timestamp).
 */
export function readOwnerLiveness(
  sessionDir: string,
  readState: LivenessStateSource,
  now: number = Date.now(),
  staleThresholdMs: number = OWNER_STALE_MS,
  readSuccessors: SuccessorSource = () => ({ kind: "unavailable", reason: "not supplied by caller" }),
): OwnerLivenessVerdict {
  const snapshot = readState();
  // Only the generation session state NAMES is consulted. An unusable value is
  // not "no marker", which would be an observation; it is a refusal to look,
  // and it flows through the ordinary arms below rather than short-circuiting,
  // so fresh owner activity still outranks it exactly as it outranks every
  // other process-level signal.
  const location = resolveTelemetryLocation(sessionDir, snapshot.heartbeatGeneration);
  const deathMarker: DeathMarkerSignal = location.kind === "unusable"
    ? { kind: "unreadable", reason: location.reason }
    : readDeathMarker(location.dir, now);
  const observed = readSuccessors();
  const signals: OwnerLivenessSignals = {
    activity: readActivity(snapshot.lastGuideCall, now, staleThresholdMs),
    lease: readLease(snapshot.lease?.expiresAt, now),
    deathMarker,
    markerValidity: readMarkerValidity(snapshot.mcpServerPid, observed, snapshot.ownerTask, snapshot.mcpGuideCallAt),
    sidecarProbe: location.kind === "unusable"
      ? { kind: "unknown", reason: location.reason, pid: null }
      : readSidecarProbe(location.dir),
    observedAt: new Date(now).toISOString(),
    staleThresholdMs,
    successors: observed,
  };

  /**
   * Last gate before authorizing anything: enumerate successors AGAIN and only
   * proceed if the answer still permits it. Closes the window between the first
   * enumeration and this return, where a replacement server coming up would
   * otherwise be missed.
   */
  const candidate = (): OwnerLivenessVerdict => {
    // ORDER MATTERS. The registry is read first and the OWNER's own state
    // LAST, so the final thing checked before authorizing is the most direct
    // refutation there is. Reading state first would leave the window between
    // that read and the registry read wide open, and a CLI `compact-prepare`
    // fits in it: it advances `lastGuideCall` and registers no successor, so
    // nothing else on this path would notice.
    //
    // The re-observation REPLACES the recorded evidence. Keeping the first
    // snapshot would let a `contradicted` verdict name a successor pid that
    // does not appear in the evidence it ships with.
    const reobserved = readSuccessors();
    const latest = readState();
    const recheck = readMarkerValidity(latest.mcpServerPid, reobserved, latest.ownerTask, latest.mcpGuideCallAt);
    const freshActivity = readActivity(latest.lastGuideCall, now, staleThresholdMs);
    const fresh = { ...signals, activity: freshActivity, markerValidity: recheck, successors: reobserved };

    // Every arm is handled explicitly. `fresh` refutes; `unknown` means the
    // latest activity could not be read at all, and falling through on it
    // would authorize on evidence we just failed to confirm.
    if (freshActivity.kind === "fresh") return { kind: "active", signals: fresh };
    if (freshActivity.kind === "unknown") {
      return {
        kind: "undetermined",
        signals: fresh,
        missing: [`owner activity on recheck (${freshActivity.reason})`],
      };
    }

    if (recheck.kind === "not-invalidated") {
      return { kind: "gone-candidate", signals: fresh };
    }
    return recheck.kind === "invalidated"
      ? {
          kind: "contradicted",
          signals: fresh,
          why: "a replacement MCP server appeared while this evidence was being gathered, " +
            "so the death marker records a restart rather than the client going away",
        }
      : { kind: "undetermined", signals: fresh, missing: [`successor check (${recheck.reason})`] };
  };

  // 1. Recent owner-task activity outranks every process-level signal, because
  //    it is the only one bound to the OWNER rather than to a server process.
  if (signals.activity.kind === "fresh") return { kind: "active", signals };
  if (signals.activity.kind === "unknown") {
    return { kind: "undetermined", signals, missing: [`owner activity (${signals.activity.reason})`] };
  }

  // 2. A death marker that a live server contradicts is stale. This is the
  //    MCP-restart case: the old server's sidecar wrote the marker on its way
  //    out, then a new server took over and the owner kept working.
  if (signals.markerValidity.kind === "invalidated") {
    return {
      kind: "contradicted",
      signals,
      why: signals.markerValidity.reason === "recorded-mcp-pid-alive"
        // Says nothing about WHOSE server it is, and does not need to: the
        // recorded server itself being alive means the marker cannot be about it.
        ? `the MCP server process recorded for this session (pid ${signals.markerValidity.pid}) is still alive, ` +
          "so any death marker predates a server that is still running"
        // Names the OWNER, because that is what the identity predicate actually
        // established (ruling C-2). "A newer server exists" would be both weaker
        // and untrue: a stranger's server supersedes nothing.
        : `the client that owns this session is still running under a different MCP server ` +
          `(pid ${(signals.markerValidity.successorPids ?? []).join(", ")}), which supersedes the one recorded ` +
          `here (pid ${signals.markerValidity.pid}), so its death marker records an ordinary server restart ` +
          "rather than the client going away",
    };
  }

  // 3. A sidecar that is still running contradicts its own marker: it writes
  //    the zero and exits, so both at once is a race we must not act on.
  if (signals.sidecarProbe.kind === "match") {
    return {
      kind: "contradicted",
      signals,
      why: `the alive sidecar (pid ${signals.sidecarProbe.pid}) is still running, which disagrees with its own death marker`,
    };
  }

  // 4. A still-ticking alive file is positive evidence of LIFE, and it outranks
  //    the ambiguity gate below. Something is writing that file right now, so
  //    the honest answer is "contradicted", not "we could not tell".
  if (signals.deathMarker.kind === "none" && now - signals.deathMarker.aliveAt < staleThresholdMs) {
    return {
      kind: "contradicted",
      signals,
      why: "the alive file is still being refreshed, so a client process is ticking for this session",
    };
  }

  // 5. AMBIGUITY SUPPRESSES THE OFFER, even alongside a positive marker.
  //    A marker says a server went away; it cannot say WHICH, so without a
  //    definitively dead recorded server pid there is nothing tying the marker
  //    to the server this session actually had. A legacy session with no
  //    recorded pid, or a pid probe that failed, is exactly that gap.
  if (signals.markerValidity.kind === "unknown") {
    return {
      kind: "undetermined",
      signals,
      missing: [`which MCP server this session had (${signals.markerValidity.reason})`],
    };
  }
  //    Likewise an unreadable sidecar identity: `unknown` is a probe that could
  //    not answer, and it must never stand in for `absent`.
  if (signals.sidecarProbe.kind === "unknown") {
    return {
      kind: "undetermined",
      signals,
      missing: [`sidecar process identity (${signals.sidecarProbe.reason})`],
    };
  }

  switch (signals.deathMarker.kind) {
    case "shutdown-marker":
    case "alive-zero":
      // The sidecar positively recorded that its parent went away, the server
      // this session recorded is definitively gone, and nothing live disagrees.
      // The strongest evidence available, and still only a CANDIDATE: it
      // attests to a server process, not to the owner task.
      return candidate();

    case "none": {
      // No marker was written. A SIGKILL of the process group, an OOM, or a
      // host reboot kills the sidecar before it can write one, so a stale
      // heartbeat plus a provably absent sidecar is the corroborated form of
      // the same observation. `unknown` never corroborates.
      if (signals.sidecarProbe.kind === "absent" && now - signals.deathMarker.aliveAt >= staleThresholdMs) {
        return candidate();
      }
      return {
        kind: "contradicted",
        signals,
        why: "the alive file is still being refreshed, so a client process is ticking for this session",
      };
    }

    case "unreadable":
      return {
        kind: "undetermined",
        signals,
        missing: [`the alive file (${signals.deathMarker.reason})`],
      };
  }
}

export function computeBinaryFingerprint(): {
  mtime: string;
  sha256: string;
} | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const parentDir = dirname(dirname(thisFile));
    const candidates = [
      join(parentDir, "mcp.js"),
      join(parentDir, "dist", "mcp.js"),
    ];
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        const buf = fs.readFileSync(p);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        return { mtime: stat.mtime.toISOString(), sha256 };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function captureClaudeCodeSessionId(): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID ?? null;
}

// Test-only export. Not part of the public API.
export const __testing = {
  hasSidecarSignature,
  inspectExistingLock,
  safeUnlinkLock,
  sleepMs,
  acquireSpawnLock,
  releaseSpawnLock,
  readSidecarPid,
  writeSidecarPid,
  killPriorSidecar: killPriorSidecarImpl,
  escalate,
  fsApi,
  probeApi,
  timeApi,
  stagingHooks,
  spawnAliveSidecarChild,
  terminateChild,
  durationOption,
  setProcessRole: (r: McpProcessRole) => { processRole = r; },
};
