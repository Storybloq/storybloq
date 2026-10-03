import { queueProgress, sessionStatus } from "./session-projection.js";
import type {
  SessionRecord,
  SessionAlert,
  SessionsPayload,
} from "./sessions-types.js";
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const string = (v: unknown, cap = 128) =>
  typeof v === "string" ? v.slice(0, cap) : null;
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const essential = (v: unknown, cap: number) =>
  typeof v === "string" && !!v.trim() && v.length <= cap;
export function statusAlerts(record: SessionRecord) {
  const alerts: SessionAlert[] = [];
  const add = (
    kind: string,
    tone: SessionAlert["tone"],
    title: string,
    detail: string,
  ) => alerts.push({ kind, tone, title, detail });
  if (record.claudeStatus?.trim().toLowerCase() === "waiting_for_input")
    add(
      "waiting",
      "madder",
      "Input needed",
      "The recorded session is waiting for your input.",
    );
  const health = record.healthState?.trim().toLowerCase();
  if (
    health &&
    !["healthy", "working", "waiting-on-build", "ended", "unknown"].includes(
      health,
    )
  )
    add(
      "health",
      ["stalled", "zombie", "crashed"].includes(health) ? "madder" : "ochre",
      "Health needs attention",
      record.healthState!,
    );
  const review = record.lastReviewVerdict;
  if (review && review.verdict.toLowerCase() !== "approve")
    add(
      "review",
      review.verdict.toLowerCase() === "reject" ? "madder" : "ochre",
      "Review: " + review.verdict,
      review.summary,
    );
  const pressure = record.contextPressure?.toLowerCase();
  if (pressure === "high" || pressure === "critical")
    add(
      "pressure",
      pressure === "critical" ? "madder" : "ochre",
      "Guide context pressure",
      record.contextPressure!,
    );
  if (record.recentDeferrals && record.recentDeferrals.critical > 0)
    add(
      "deferrals",
      "madder",
      "Critical deferrals",
      `${record.recentDeferrals.critical} critical of ${record.recentDeferrals.total} recorded deferrals`,
    );
  return alerts;
}
/** A bounded read-side allowlist for StatusPayload. Never return the parsed source object. */
export function parseStatus(
  text: string | undefined,
  now: number,
): SessionsPayload["status"] {
  if (text === undefined) return { kind: "missing" };
  let raw;
  try {
    raw = obj(JSON.parse(text));
  } catch {
    return { kind: "malformed" };
  }
  if (
    typeof raw.schemaVersion === "number" &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion > 1
  )
    return { kind: "unsupported" };
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.sessionActive !== "boolean" ||
    !essential(raw.source, 128)
  )
    return { kind: "malformed" };
  if (raw.sessionActive === false) return { kind: "inactive" };
  if (
    !essential(raw.sessionId, 128) ||
    !uuid.test(raw.sessionId as string) ||
    !essential(raw.state, 128) ||
    !essential(raw.observedAt, 80)
  )
    return { kind: "malformed" };
  let truncated = false;
  const clip = (v: unknown, cap: number) => {
    if (typeof v === "string" && v.length > cap) truncated = true;
    return string(v, cap);
  };
  const list = (v: unknown) => {
    if (!Array.isArray(v)) return [];
    if (v.length > 500) truncated = true;
    return v
      .slice(0, 500)
      .filter((x): x is string => typeof x === "string")
      .map((s) => clip(s, 80)!);
  };
  const ticket = clip(raw.ticket, 80)?.trim(),
    issue = obj(raw.currentIssue);
  const issueId = clip(issue.displayId ?? issue.id, 80)?.trim();
  const currentWork: SessionRecord["currentWork"] = ticket
    ? {
        id: ticket,
        title: clip(raw.ticketTitle, 2000)?.trim() || "Current Work",
        kind: "ticket",
        tag: clip(raw.risk, 128)?.trim() || null,
      }
    : issueId
      ? {
          id: issueId,
          title: clip(issue.title, 2000)?.trim() || "Current Issue",
          kind: "issue",
          tag: clip(issue.severity, 128)?.trim() || null,
        }
      : null;
  const targetWork = list(raw.targetWork),
    completedThisSession = list(raw.completedThisSession);
  const review = obj(raw.lastReviewVerdict),
    deferrals = obj(raw.recentDeferrals),
    pressure = obj(raw.tokenPressure);
  const processes = Array.isArray(raw.runningSubprocesses)
    ? raw.runningSubprocesses
    : [];
  if (processes.length > 200) truncated = true;
  const runningSubprocesses = processes
    .slice(0, 200)
    .map(obj)
    .filter(
      (p) =>
        count(p.pid) > 0 &&
        typeof p.category === "string" &&
        typeof p.stage === "string" &&
        typeof p.startedAt === "string",
    )
    .map((p) => ({
      pid: count(p.pid),
      category: clip(p.category, 128)!,
      stage: clip(p.stage, 128)!,
      startedAt: clip(p.startedAt, 80)!,
    }));
  const record: SessionRecord = {
    sessionId: raw.sessionId as string,
    state: raw.state as string,
    observedAt: raw.observedAt as string,
    source: raw.source as string,
    startedAt: clip(raw.startedAt, 80),
    substage: clip(raw.substage, 128),
    substageStartedAt: clip(raw.substageStartedAt, 80),
    branch: clip(raw.branch, 256),
    claudeStatus: clip(raw.claudeStatus, 128),
    healthState: clip(raw.healthState, 128),
    alive: typeof raw.alive === "boolean" ? raw.alive : null,
    lastMcpCall: clip(raw.lastMcpCall, 80),
    lastGuideCall: clip(raw.lastGuideCall, 80),
    contextPressure: clip(raw.contextPressure, 128),
    tokenPressure:
      typeof pressure.state === "string"
        ? {
            state: [
              "ok",
              "advisory",
              "imperative",
              "compact-needed",
              "unknown",
            ].includes(pressure.state)
              ? pressure.state
              : "unknown",
            pctBucket:
              typeof pressure.pctBucket === "number" &&
              Number.isFinite(pressure.pctBucket) &&
              pressure.pctBucket >= 0 &&
              pressure.pctBucket <= 100
                ? pressure.pctBucket
                : null,
            ceilingSource: clip(pressure.ceilingSource, 64) ?? "unknown",
            ceilingConfidence: clip(pressure.ceilingConfidence, 64),
            compactNeeded: pressure.compactNeeded === true,
          }
        : null,
    currentWork,
    targetWork,
    completedThisSession,
    queue: queueProgress({
      targetWork,
      completedThisSession,
      currentTicket: ticket,
      currentIssue: issueId,
    }),
    derivedStatus: "working",
    runningSubprocesses,
    lastReviewVerdict:
      typeof review.verdict === "string"
        ? {
            stage: clip(review.stage, 128) ?? "",
            round: count(review.round),
            verdict: clip(review.verdict, 128)!,
            findingCount: count(review.findingCount),
            criticalCount: count(review.criticalCount),
            majorCount: count(review.majorCount),
            suggestionCount: count(review.suggestionCount),
            durationMs: count(review.durationMs),
            summary: clip(review.summary, 2000) ?? "",
          }
        : null,
    recentDeferrals:
      raw.recentDeferrals && typeof raw.recentDeferrals === "object"
        ? {
            total: count(deferrals.total),
            critical: count(deferrals.critical),
            high: count(deferrals.high),
            medium: count(deferrals.medium),
            low: count(deferrals.low),
          }
        : null,
    alerts: [],
    telemetryAvailable: false,
    truncated,
  };
  // All optional projections above run before storing this aggregate clipping flag.
  record.truncated = truncated;
  record.derivedStatus = sessionStatus(record, now);
  record.alerts = statusAlerts(record);
  return { kind: "active", record };
}
