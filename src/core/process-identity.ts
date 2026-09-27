/**
 * Process identity: a pid plus a signature (uid, start time, command) so a
 * recycled pid is never mistaken for the process that wrote a lock body.
 * Shared by the project lock and the limit lock.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";

/**
 * Identity signature for a live process: uid + start time + command. Two
 * different processes recycling the same PID produce different signatures.
 * Sync port of src/bus/lock.ts captureProcessSignature.
 */
export function captureProcessSignatureSync(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,command="], {
        encoding: "utf-8",
        timeout: 500,
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const normalized = out.trim().replace(/\s+/g, " ");
      if (!normalized) return null;
      return "darwin:" + createHash("sha256").update(normalized).digest("hex");
    }
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const rightParen = raw.lastIndexOf(")");
      if (rightParen < 0) return null;
      const fields = raw.slice(rightParen + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const st = fs.statSync(`/proc/${pid}`);
      return startTicks ? `linux:${st.uid}:${startTicks}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export type ProcessIdentity = "alive" | "dead" | "unknown";

export function inspectProcessIdentitySync(pid: number, expectedSignature: string | null): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM: pid exists but belongs to another uid -- cannot be our holder.
    if (code === "EPERM") return "dead";
    return "unknown";
  }
  if (!expectedSignature) return "unknown";
  const actual = captureProcessSignatureSync(pid);
  if (!actual) return "unknown";
  return actual === expectedSignature ? "alive" : "dead";
}
