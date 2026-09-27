/**
 * T-424: `storybloq limit-status` -- the human surface for the global limit
 * ledger. T-534 retired the auto-resume: the command is read-only (it lists
 * what the ledger still holds until the retirement removes it) and refuses
 * --cancel and --requeue. It is deleted with the runtime.
 */

import { listLimitStops, type LimitStopSummary } from "../../core/limit-ledger.js";

export interface LimitStatusOptions {
  cancel?: string;
  requeue?: string;
  format?: "json" | "md";
  /** ISS-944: include terminal records (defer_exhausted, attempts_exhausted, etc.) without needing the key. */
  recent?: boolean;
}

export interface LimitStatusResult {
  output: string;
  errorCode?: string;
}

function formatList(stops: LimitStopSummary[], format: "json" | "md"): string {
  if (format === "json") {
    return JSON.stringify({ ok: true, data: { limitStops: stops } }, null, 2);
  }
  if (stops.length === 0) {
    return "No pending limit auto-resumes.";
  }
  const lines = ["# Limit auto-resume queue", ""];
  for (const s of stops) {
    const when = new Date(s.nextAttemptAt).toLocaleString();
    const reason = s.reasonCode ? ` [${s.reasonCode}]` : "";
    // Action text follows STATUS, not just mode: a manual record is stood
    // down (nothing is scheduled) and cancelling/preparing are transitions.
    const action = s.status === "manual"
      ? (s.reasonCode === "cancellation_blocked"
          ? "cancellation blocked on a live wake child"
          : "stood down")
      : s.status === "cancelling"
        ? "cancellation in progress"
        : s.status === "preparing"
          ? "detection in progress"
          : s.status === "resuming"
            ? "auto-resume in progress"
            : s.status === "interactive"
              ? "interactive resume in progress"
              // ISS-944: --recent surfaces terminal records too; they are not
              // scheduled for anything further. Only "failed" is requeueable
              // (LIMIT_STATUS_META) -- resumed/notified/cancelled are done.
              : s.status === "failed"
                ? "terminal"
                : s.status === "resumed" || s.status === "notified" || s.status === "cancelled"
                  ? "terminal, episode complete"
                  // Only stopped/deferred are actually SCHEDULED for a future moment.
                  : `${s.mode === "headless" ? "auto-resumes" : "notifies"} ~${when}`;
    lines.push(`- ${s.key}`);
    lines.push(`    ${s.sessionType} session in ${s.projectRoot}`);
    lines.push(
      `    ${s.status}${reason} -- ${s.limitType} limit, ${action}` +
      ` (generation ${s.generation}, attempts ${s.wakeAttempts})`,
    );
  }
  lines.push("", "Usage-limit auto-resume is retired; nothing listed here will run. The records clear with the retirement.");
  return lines.join("\n");
}

export async function handleLimitStatus(options: LimitStatusOptions = {}): Promise<LimitStatusResult> {
  if (options.cancel && options.requeue) {
    return { output: "Pass either --cancel or --requeue, not both.", errorCode: "invalid_input" };
  }
  if (options.cancel || options.requeue) {
    return {
      output: "Usage-limit auto-resume is retired: nothing is scheduled, so there is nothing to cancel or requeue.",
      errorCode: "invalid_input",
    };
  }
  return {
    output: formatList(listLimitStops(options.recent ? { includeTerminal: true } : undefined), options.format ?? "md"),
  };
}
