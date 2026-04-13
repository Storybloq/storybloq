import {
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type {
  SessionState,
  StatusPayload,
} from "./session-types.js";
import { buildActivePayload, buildInactivePayload } from "./status-payload.js";
import { readLastMcpCall, readAliveTimestamp } from "./liveness.js";
import { readSubprocessSummaries } from "./subprocess-registry.js";

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

export function writeStatusFile(root: string, payload: StatusPayload): boolean {
  try {
    const statusPath = join(root, ".story", "status.json");
    const content = JSON.stringify(payload, null, 2) + "\n";
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
      const aliveTs = readAliveTimestamp(dir);
      const subprocesses = readSubprocessSummaries(dir);
      const activePayload = buildActivePayload(state as SessionState, {
        lastMcpCall,
        alive: aliveTs !== null,
        runningSubprocesses: subprocesses.length > 0 ? subprocesses : null,
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
