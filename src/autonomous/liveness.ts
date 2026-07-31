import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SuccessorServers } from "./mcp-registry.js";
import { isSameOwnerTask, type OwnerTask } from "./client-profile.js";

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
const fsApi = {
  linkSync: fs.linkSync,
  renameSync: fs.renameSync,
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
    " \u2014 PID-reuse guard cannot match the sidecar in ps/proc output; refusing to load."
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

export function spawnAliveSidecar(tDir: string, intervalMs = 10_000): number | null {
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
    return existing;
  }

  let spawnedPid: number | null = null;
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
        spawnedPid = newPid;
      } catch (e: any) {
        livenessLog("write-pid-failed", { code: e?.code, newPid });
        // We just spawned this pid; bypass the signature gate (which races
        // the ps/proc table write for a freshly-forked child) and signal
        // it directly. SIGTERM, poll for exit, then SIGKILL if needed.
        killJustSpawnedChild(newPid);
        return null;
      }
    }
    return spawnedPid;
  } finally {
    releaseSpawnLock(handle);
  }
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

export function readAliveTimestamp(sessionDir: string): number | null {
  const tDir = telemetryDirPath(sessionDir);
  if (fs.existsSync(join(tDir, "shutdown"))) return null;
  try {
    const val = fs.readFileSync(join(tDir, "alive"), "utf-8").trim();
    const n = Number(val);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
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
      readonly reason: "absent" | "non-numeric" | "future" | "raced" | "no-marker-time";
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
  | { readonly kind: "unknown"; readonly reason: "no-pid" | "probe-unknown"; readonly pid: number | null };

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
  const tDir = telemetryDirPath(sessionDir);
  const deathMarker = readDeathMarker(tDir, now);
  const observed = readSuccessors();
  const signals: OwnerLivenessSignals = {
    activity: readActivity(snapshot.lastGuideCall, now, staleThresholdMs),
    lease: readLease(snapshot.lease?.expiresAt, now),
    deathMarker,
    markerValidity: readMarkerValidity(snapshot.mcpServerPid, observed, snapshot.ownerTask, snapshot.mcpGuideCallAt),
    sidecarProbe: readSidecarProbe(tDir),
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
  setProcessRole: (r: McpProcessRole) => { processRole = r; },
};
