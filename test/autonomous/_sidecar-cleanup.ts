/**
 * ISS-552: Shared teardown helper for integration tests that spawn
 * liveness sidecars via `handleAutonomousGuide`.
 *
 * `rmSync` on the tmp session dir does NOT kill the sidecar subprocess —
 * the process holds no file lock and keeps running (its `ppid` liveness
 * check only fires once per intervalMs, defaulting to 10s). Repeated
 * test runs accumulate orphan Node processes writing heartbeats to
 * deleted paths. Call `killSidecarsInRoot(root)` in `afterEach` BEFORE
 * `rmSync` to signal every sidecar whose pid is recorded in a session's
 * state.json.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { killSidecar } from "../../src/autonomous/liveness.js";

/**
 * Scan `<root>/.story/sessions/* /state.json` and SIGTERM every
 * `sidecarPid` found. Silently ignores missing dirs / malformed files
 * so it is safe to call regardless of how far a test progressed.
 */
export function killSidecarsInRoot(root: string): void {
  const sessionsDir = join(root, ".story", "sessions");
  let entries: string[];
  try { entries = readdirSync(sessionsDir); } catch { return; }
  for (const name of entries) {
    const statePath = join(sessionsDir, name, "state.json");
    try {
      if (!statSync(statePath).isFile()) continue;
      const raw = readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw) as { sidecarPid?: number | null };
      const pid = parsed.sidecarPid;
      if (typeof pid === "number" && pid > 0) killSidecar(pid);
    } catch { /* best-effort: missing dir, bad json, stale pid — ignore */ }
  }
}
