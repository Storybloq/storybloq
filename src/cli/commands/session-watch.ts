import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { findActiveSessionMinimal } from "../../autonomous/session.js";
import { resolveSessionSelector } from "../../autonomous/session-selector.js";
import { deriveHealthState, type HealthState } from "../../autonomous/health-model.js";

export async function handleSessionWatch(
  root: string,
  sessionId: string | undefined,
  opts: { events?: boolean; quiet?: boolean },
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
  let lastState: HealthState | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function evaluate(): void {
    try {
      const result = deriveHealthState(dir);
      if (opts.quiet && result.healthState === lastState) return;

      if (opts.events) {
        const event = {
          ts: result.derivedAt,
          sessionId: result.sessionId,
          healthState: result.healthState,
          probes: result.probes,
        };
        process.stdout.write(JSON.stringify(event) + "\n");
      } else {
        const ts = new Date().toISOString().slice(11, 19);
        process.stdout.write(`[${ts}] ${result.sessionId.slice(0, 8)} ${result.healthState}\n`);
      }
      lastState = result.healthState;
    } catch (err: unknown) {
      process.stderr.write(`evaluate error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  function onFileChange(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(evaluate, 500);
  }

  const watchers: FSWatcher[] = [];
  let hasTelemetryWatcher = false;
  try {
    watchers.push(watch(join(dir, "telemetry"), { recursive: true }, onFileChange));
    hasTelemetryWatcher = true;
  } catch { /* dir may not exist yet */ }
  try {
    watchers.push(watch(dir, { recursive: false }, (_, filename) => {
      if (filename === "state.json") onFileChange();
    }));
  } catch { /* dir may not exist */ }

  if (watchers.length === 0) {
    process.stderr.write("No watchable directories found for session.\n");
    process.exitCode = 1;
    return;
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (!hasTelemetryWatcher) {
    pollTimer = setInterval(onFileChange, 5_000);
  }

  evaluate();

  const cleanup = (): void => {
    for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await new Promise<void>(() => {});
}
