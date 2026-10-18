import { computeElapsedWithClockSkew } from "../../src/core/clock-skew.js";
export interface PresenceEvidence {
  startedAt: string;
  lastEventAt?: string | null;
  endedAt?: string | null;
  suppressed?: boolean;
  openTools?: readonly unknown[];
}
export const parseSessionTime = (value: unknown): number | null => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
export function presenceActivity(record: PresenceEvidence, now: number) {
  let state:
    | "ended"
    | "unknown"
    | "stale"
    | "working"
    | "maybeWorking"
    | "idleRecent";
  if (record.endedAt != null) state = "ended";
  else {
    const anchor =
        parseSessionTime(record.lastEventAt) ??
        parseSessionTime(record.startedAt),
      elapsed = anchor === null ? null : now - anchor;
    if (elapsed === null || elapsed < -120000) state = "unknown";
    else if (elapsed >= 43200000) state = "stale";
    else if (record.openTools?.length)
      state = elapsed < 120000 ? "working" : "maybeWorking";
    else state = elapsed < 600000 ? "idleRecent" : "unknown";
  }
  return {
    state,
    visible:
      record.suppressed !== true && state !== "ended" && state !== "stale",
    animates: state === "working" || state === "idleRecent",
  };
}
export function sessionStatus(
  signals: {
    claudeStatus?: string | null;
    alive?: boolean | null;
    lastMcpCall?: string | null;
    healthState?: string | null;
  },
  now: number,
) {
  if (signals.claudeStatus?.trim().toLowerCase() === "waiting_for_input")
    return "needsInput";
  if (signals.alive === false) return "unresponsive";
  if (signals.lastMcpCall != null) {
    const time = parseSessionTime(signals.lastMcpCall);
    if (time === null) return "stale";
    if (now - time >= 300000) return "unresponsive";
    if (now - time >= 120000) return "stale";
  }
  const health = signals.healthState?.toLowerCase();
  if (["stalled", "zombie", "crashed"].includes(health ?? ""))
    return "unresponsive";
  if (
    ["degraded", "waiting-on-dialog", "telemetry-stale"].includes(health ?? "")
  )
    return "degraded";
  return "working";
}
export function queueProgress(input: {
  targetWork: readonly string[];
  completedThisSession?: readonly string[];
  currentTicket?: string | null;
  currentIssue?: string | null;
}) {
  const ids = [
      ...new Set(input.targetWork.map((s) => s.trim()).filter(Boolean)),
    ],
    done = new Set(
      input.completedThisSession?.map((s) => s.trim()).filter(Boolean),
    ),
    current = input.currentTicket?.trim() || input.currentIssue?.trim();
  const completed = ids.filter((id) => done.has(id)).length,
    total = ids.length;
  return {
    completed,
    total,
    fraction: total ? completed / total : 0,
    items: ids.map((id) => ({
      id,
      status: done.has(id) ? "done" : id === current ? "current" : "queued",
    })),
  };
}
export function supervision(
  entries: readonly {
    role: string;
    supervising?: { workerActive: boolean } | null;
  }[],
) {
  const pens = entries.filter((e) => e.role === "pen");
  if (!pens.length) return null;
  const active = pens.filter((e) => e.supervising?.workerActive).length;
  return pens.length === 1
    ? `Supervising -- worker ${active ? "active" : "not active"}`
    : `Supervising ${pens.length} arrangements (${active} active)`;
}
export function milestoneProjection(
  m: { kind: string; at: string; gateName?: string; note?: string } | null,
  now: number,
) {
  if (!m) return null;
  const label =
    m.kind === "implementing"
      ? "Implementing"
      : m.kind === "reviewing"
        ? "Reviewing"
        : m.kind === "blocked-external"
          ? "Blocked on something external"
          : m.kind === "gate-hold"
            ? "Holding at gate" + (m.gateName ? " " + m.gateName : "")
            : "Milestone: " + m.kind;
  const elapsed = computeElapsedWithClockSkew(m.at, now);
  return {
    kind: m.kind,
    at: m.at,
    label,
    gateName: m.gateName ?? null,
    note: m.note ?? null,
    ...elapsed,
    overdue: !elapsed.clockAnomaly && elapsed.elapsedSeconds > 900,
    selfReported: true as const,
  };
}
