import { findActiveSessionMinimal } from "../../autonomous/session.js";
import { resolveSessionSelector } from "../../autonomous/session-selector.js";
import { deriveHealthState } from "../../autonomous/health-model.js";

export async function handleSessionHealth(
  root: string,
  sessionId: string | undefined,
): Promise<void> {
  let id = sessionId;
  if (!id) {
    const active = findActiveSessionMinimal(root);
    if (!active) {
      process.stderr.write("No active session found.\n");
      process.exitCode = 1;
      return;
    }
    id = active.sessionId;
  }

  const res = resolveSessionSelector(root, id);
  if (res.kind !== "resolved") {
    if (res.kind === "ambiguous") {
      process.stderr.write(`Ambiguous selector "${id}". Matches: ${res.matches.join(", ")}\n`);
    } else if (res.kind === "invalid") {
      process.stderr.write(res.reason + "\n");
    } else {
      process.stderr.write(`Session ${id} not found.\n`);
    }
    process.exitCode = 1;
    return;
  }
  const dir = res.dir;
  const result = deriveHealthState(dir);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  const ok = result.healthState === "healthy" || result.healthState === "working" || result.healthState === "waiting-on-build" || result.healthState === "ended" || result.healthState === "unknown";
  if (!ok) {
    process.exitCode = 1;
  }
}
