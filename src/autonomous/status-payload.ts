import {
  deriveClaudeStatus,
  CURRENT_STATUS_SCHEMA_VERSION,
  type SessionState,
  type StatusPayloadActive,
  type StatusPayloadInactive,
} from "./session-types.js";

export function buildActivePayload(
  session: SessionState,
  telemetry?: {
    lastMcpCall?: string | null;
    alive?: boolean | null;
    runningSubprocesses?: ReadonlyArray<{ pid: number; category: string; startedAt: string; stage: string }> | null;
    healthState?: string | null;
  },
): StatusPayloadActive {
  return {
    schemaVersion: CURRENT_STATUS_SCHEMA_VERSION,
    sessionActive: true,
    sessionId: session.sessionId,
    state: session.state,
    ticket: session.ticket?.id ?? null,
    ticketTitle: session.ticket?.title ?? null,
    risk: session.ticket?.risk ?? null,
    claudeStatus: deriveClaudeStatus(session.state, session.waitingForRetry),
    observedAt: new Date().toISOString(),
    lastGuideCall: session.lastGuideCall ?? null,
    completedThisSession: session.completedTickets?.map((t) => t.id) ?? [],
    contextPressure: session.contextPressure?.level ?? "unknown",
    branch: session.git?.branch ?? null,
    source: "hook",
    substage: session.substage ?? null,
    substageStartedAt: session.substageStartedAt ?? null,
    pendingInstruction: session.pendingInstruction ?? null,
    pendingInstructionSetAt: session.pendingInstructionSetAt ?? null,
    claudeCodeSessionId: session.claudeCodeSessionId ?? null,
    binaryFingerprint: session.binaryFingerprint ?? null,
    runningSubprocesses: telemetry?.runningSubprocesses ?? session.runningSubprocesses ?? null,
    lastReviewVerdict: session.lastReviewVerdict ?? null,
    recentDeferrals: session.recentDeferrals ?? null,
    alive: telemetry?.alive ?? session.alive ?? null,
    lastMcpCall: telemetry?.lastMcpCall ?? session.lastMcpCall ?? null,
    healthState: telemetry?.healthState ?? session.healthState ?? null,
    // T-271: Queue progress
    // ISS-490: Use optional chaining instead of non-null assertion.
    targetWork: session.targetWork?.length ? [...session.targetWork] : null,
    currentIssue: session.currentIssue
      ? { id: session.currentIssue.id, title: session.currentIssue.title, severity: session.currentIssue.severity }
      : null,
  };
}

export function buildInactivePayload(): StatusPayloadInactive {
  return {
    schemaVersion: CURRENT_STATUS_SCHEMA_VERSION,
    sessionActive: false,
    source: "hook",
  };
}
