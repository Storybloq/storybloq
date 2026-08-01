/**
 * Session-write plumbing shared by the guide and its extracted stages.
 *
 * WHY THIS MODULE EXISTS (T-450 step 6a). The cancellation finalizer is being
 * extracted from `guide.ts` into a `cancellation-transition.ts` that does not
 * exist yet: this commit is the structural half, and the extraction lands with
 * the behavior half. That finalizer depends on these three helpers, which is
 * what forces the question of where they live.
 *
 * Leaving them in `guide.ts` would make the coming feature module import the
 * guide, inverting the dependency rather than removing it. Moving them INTO the
 * cancellation module would be worse: the thirteen unrelated `guide.ts` call
 * sites of `writeSessionAndRefresh` would then depend on a cancellation feature
 * module, an ownership inversion that invites the next cycle.
 *
 * So they live here, in a module that owns nothing feature-specific and imports
 * nothing from `guide.ts`. The intended graph, once the extraction lands, is
 * acyclic by construction:
 *
 *     guide.ts -> cancellation-transition.ts -> guide-effects.ts
 *     guide.ts -----------------------------> guide-effects.ts
 *
 * Today only the second edge exists.
 *
 * These functions are RELOCATED VERBATIM. Their behavior, including the
 * best-effort catches, is pinned by the T-450 step 5 characterization suite,
 * which mocks `status-writer.js` and `telemetry-writer.js` BY PATH; this move
 * touches neither path, so those interceptions keep working unchanged.
 */
import { writeSessionSync } from "./session.js";
import { refreshStatusForSession, isSessionActiveForStatus } from "./status-writer.js";
import { writeEvent, writeCheckpoint, markEnded, type TelemetryLayer } from "./telemetry-writer.js";
import type { FullSessionState } from "./session-types.js";

export type RefreshMode = "always" | "if-active" | "never";

/**
 * Persist session state, then refresh the project status file.
 *
 * The refresh is BEST EFFORT and deliberately so: the state write is the
 * source of truth, and a failure to update a derived convenience file must not
 * fail an operation that already durably succeeded. The step 5 suite pins this
 * by injecting a throw from `refreshStatusForSession` and requiring the rest of
 * the cancellation tail to run anyway.
 */
export function writeSessionAndRefresh(
  root: string,
  dir: string,
  state: FullSessionState,
  mode: RefreshMode = "if-active",
): FullSessionState {
  const written = writeSessionSync(dir, state);
  if (mode === "never") return written;
  if (mode === "if-active" && !isSessionActiveForStatus(written)) return written;
  try { refreshStatusForSession(root, dir, written, "guide"); } catch { /* best-effort */ }
  return written;
}

// ---------------------------------------------------------------------------
// T-262: Telemetry helpers -- called AFTER state persistence completes
// ---------------------------------------------------------------------------

export function emitTelemetry(dir: string, type: string, layer: TelemetryLayer, data: Record<string, unknown>): void {
  writeEvent(dir, { ts: new Date().toISOString(), layer, type, data });
}

export function postStateWrite(dir: string, opts: {
  event?: { type: string; layer: TelemetryLayer; data: Record<string, unknown> };
  checkpoint?: { stage: string; state: Record<string, unknown>; revision: number };
  ended?: { reason: string };
}): void {
  if (opts.event) emitTelemetry(dir, opts.event.type, opts.event.layer, opts.event.data);
  if (opts.checkpoint) writeCheckpoint(dir, opts.checkpoint.stage, opts.checkpoint.state as Record<string, unknown>, opts.checkpoint.revision);
  if (opts.ended) markEnded(dir, opts.ended.reason);
}
