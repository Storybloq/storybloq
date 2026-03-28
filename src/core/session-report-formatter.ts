/**
 * Session report formatter — renders 7-section structured analysis.
 * All sections always present; missing data uses "Not available" placeholders.
 */
import type { FullSessionState, EventEntry } from "../autonomous/session-types.js";
import type { OutputFormat } from "../models/types.js";

export interface SessionReportData {
  readonly state: FullSessionState;
  readonly events: { events: readonly EventEntry[]; malformedCount: number };
  readonly planContent: string | null;
  readonly gitLog: string[] | null;
}

export function formatSessionReport(
  data: SessionReportData,
  format: OutputFormat,
): string {
  const { state, events, planContent, gitLog } = data;

  if (format === "json") {
    return JSON.stringify({
      ok: true,
      data: {
        summary: buildSummaryData(state),
        ticketProgression: state.completedTickets,
        reviewStats: state.reviews,
        events: events.events.slice(-50),
        malformedEventCount: events.malformedCount,
        contextPressure: state.contextPressure,
        git: {
          branch: state.git.branch,
          initHead: state.git.initHead,
          commits: gitLog,
        },
        problems: buildProblems(state, events),
      },
    }, null, 2);
  }

  const sections: string[] = [];

  // 1. Session Summary
  sections.push(buildSummarySection(state));

  // 2. Ticket Progression
  sections.push(buildTicketSection(state));

  // 3. Review Stats
  sections.push(buildReviewSection(state));

  // 4. Event Timeline
  sections.push(buildEventSection(events));

  // 5. Context Pressure
  sections.push(buildPressureSection(state));

  // 6. Git Summary
  sections.push(buildGitSection(state, gitLog));

  // 7. Problems
  sections.push(buildProblemsSection(state, events));

  return sections.join("\n\n---\n\n");
}

// --- Section builders ---

function buildSummaryData(state: FullSessionState) {
  return {
    sessionId: state.sessionId,
    mode: state.mode ?? "auto",
    recipe: state.recipe,
    status: state.status,
    terminationReason: state.terminationReason,
    startedAt: state.startedAt,
    lastGuideCall: state.lastGuideCall,
    guideCallCount: state.guideCallCount,
    ticketsCompleted: state.completedTickets.length,
  };
}

function buildSummarySection(state: FullSessionState): string {
  const duration = state.startedAt && state.lastGuideCall
    ? formatDuration(state.startedAt, state.lastGuideCall)
    : "unknown";
  return [
    "## Session Summary",
    "",
    `- **ID:** ${state.sessionId}`,
    `- **Mode:** ${state.mode ?? "auto"}`,
    `- **Recipe:** ${state.recipe}`,
    `- **Status:** ${state.status}${state.terminationReason ? ` (${state.terminationReason})` : ""}`,
    `- **Duration:** ${duration}`,
    `- **Guide calls:** ${state.guideCallCount}`,
    `- **Tickets completed:** ${state.completedTickets.length}`,
  ].join("\n");
}

function buildTicketSection(state: FullSessionState): string {
  if (state.completedTickets.length === 0) {
    const current = state.ticket;
    if (current) {
      return [
        "## Ticket Progression",
        "",
        `In progress: **${current.id}** — ${current.title} (risk: ${current.risk ?? "unknown"})`,
      ].join("\n");
    }
    return "## Ticket Progression\n\nNo tickets completed.";
  }

  const lines = ["## Ticket Progression", ""];
  for (const t of state.completedTickets) {
    const risk = t.realizedRisk
      ? `${t.risk ?? "?"} → ${t.realizedRisk}`
      : (t.risk ?? "unknown");
    lines.push(`- **${t.id}:** ${t.title} | risk: ${risk} | commit: \`${t.commitHash ?? "?"}\``);
  }
  return lines.join("\n");
}

function buildReviewSection(state: FullSessionState): string {
  const plan = state.reviews.plan;
  const code = state.reviews.code;

  if (plan.length === 0 && code.length === 0) {
    return "## Review Stats\n\nNo reviews recorded.";
  }

  const lines = ["## Review Stats", ""];

  if (plan.length > 0) {
    lines.push(`**Plan reviews:** ${plan.length} round(s)`);
    for (const r of plan) {
      lines.push(`  - Round ${r.round}: ${r.verdict} (${r.findingCount} findings, ${r.criticalCount} critical, ${r.majorCount} major) — ${r.reviewer}`);
    }
  }

  if (code.length > 0) {
    lines.push(`**Code reviews:** ${code.length} round(s)`);
    for (const r of code) {
      lines.push(`  - Round ${r.round}: ${r.verdict} (${r.findingCount} findings, ${r.criticalCount} critical, ${r.majorCount} major) — ${r.reviewer}`);
    }
  }

  const totalFindings = [...plan, ...code].reduce((sum, r) => sum + r.findingCount, 0);
  lines.push("", `**Total findings:** ${totalFindings}`);

  return lines.join("\n");
}

function buildEventSection(events: { events: readonly EventEntry[]; malformedCount: number }): string {
  if (events.events.length === 0 && events.malformedCount === 0) {
    return "## Event Timeline\n\nNot available.";
  }

  const capped = events.events.slice(-50);
  const omitted = events.events.length - capped.length;
  const lines = ["## Event Timeline", ""];
  if (omitted > 0) {
    lines.push(`*${omitted} earlier events omitted*`, "");
  }
  for (const e of capped) {
    const ts = e.timestamp ? e.timestamp.slice(11, 19) : "??:??:??";
    const detail = e.data ? Object.entries(e.data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ") : "";
    lines.push(`- \`${ts}\` [${e.type}] ${detail}`.trimEnd());
  }
  if (events.malformedCount > 0) {
    lines.push("", `*${events.malformedCount} malformed event line(s) skipped*`);
  }
  return lines.join("\n");
}

function buildPressureSection(state: FullSessionState): string {
  const p = state.contextPressure;
  return [
    "## Context Pressure",
    "",
    `- **Level:** ${p.level}`,
    `- **Guide calls:** ${p.guideCallCount}`,
    `- **Tickets completed:** ${p.ticketsCompleted}`,
    `- **Compactions:** ${p.compactionCount}`,
    `- **Events log:** ${p.eventsLogBytes} bytes`,
  ].join("\n");
}

function buildGitSection(state: FullSessionState, gitLog: string[] | null): string {
  const lines = [
    "## Git Summary",
    "",
    `- **Branch:** ${state.git.branch ?? "unknown"}`,
    `- **Init HEAD:** \`${state.git.initHead ?? "?"}\``,
    `- **Expected HEAD:** \`${state.git.expectedHead ?? "?"}\``,
  ];

  if (gitLog && gitLog.length > 0) {
    lines.push("", "**Commits:**");
    for (const c of gitLog) {
      lines.push(`- ${c}`);
    }
  } else {
    lines.push("", "Commits: Not available.");
  }

  return lines.join("\n");
}

function buildProblems(
  state: FullSessionState,
  events: { events: readonly EventEntry[]; malformedCount: number },
): string[] {
  const problems: string[] = [];

  if (state.terminationReason && state.terminationReason !== "normal") {
    problems.push(`Abnormal termination: ${state.terminationReason}`);
  }

  if (events.malformedCount > 0) {
    problems.push(`${events.malformedCount} malformed event line(s) in events.log`);
  }

  for (const e of events.events) {
    if (e.type.includes("error") || e.type.includes("exhaustion")) {
      problems.push(`[${e.type}] ${e.timestamp ?? ""} ${JSON.stringify(e.data)}`);
    } else if (e.data?.result === "exhaustion") {
      problems.push(`[${e.type}] exhaustion at ${e.timestamp ?? ""}`);
    }
  }

  if (state.deferralsUnfiled) {
    problems.push("Session has unfiled deferrals");
  }

  return problems;
}

function buildProblemsSection(
  state: FullSessionState,
  events: { events: readonly EventEntry[]; malformedCount: number },
): string {
  const problems = buildProblems(state, events);
  if (problems.length === 0) {
    return "## Problems\n\nNone detected.";
  }
  return ["## Problems", "", ...problems.map((p) => `- ${p}`)].join("\n");
}

// --- Helpers ---

function formatDuration(start: string, end: string): string {
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (isNaN(ms) || ms < 0) return "unknown";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  } catch {
    return "unknown";
  }
}
