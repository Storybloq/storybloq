import type {
  presenceActivity,
  queueProgress,
  milestoneProjection,
  sessionStatus,
} from "./session-projection.js";
export interface SessionAlert {
  kind: string;
  tone: "madder" | "ochre";
  title: string;
  detail: string;
}
export interface SessionRecord {
  sessionId: string;
  state: string;
  observedAt: string;
  source: string;
  startedAt: string | null;
  substage: string | null;
  substageStartedAt: string | null;
  branch: string | null;
  claudeStatus: string | null;
  healthState: string | null;
  alive: boolean | null;
  lastMcpCall: string | null;
  lastGuideCall: string | null;
  contextPressure: string | null;
  tokenPressure: {
    state: string;
    pctBucket: number | null;
    ceilingSource: string;
    ceilingConfidence: string | null;
    compactNeeded: boolean;
  } | null;
  currentWork: {
    id: string;
    title: string;
    kind: "ticket" | "issue";
    tag: string | null;
  } | null;
  targetWork: string[];
  completedThisSession: string[];
  queue: ReturnType<typeof queueProgress>;
  derivedStatus: ReturnType<typeof sessionStatus>;
  runningSubprocesses: {
    pid: number;
    category: string;
    stage: string;
    startedAt: string;
  }[];
  lastReviewVerdict: {
    stage: string;
    round: number;
    verdict: string;
    findingCount: number;
    criticalCount: number;
    majorCount: number;
    suggestionCount: number;
    durationMs: number;
    summary: string;
  } | null;
  recentDeferrals: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  } | null;
  alerts: SessionAlert[];
  telemetryAvailable: boolean;
  truncated: boolean;
}
export interface PresenceRow {
  sessionId: string;
  startedAt: string;
  lastEventAt: string;
  source: string | null;
  agentCount: number;
  activity: ReturnType<typeof presenceActivity>;
  openTools: {
    id: string;
    tool: string;
    target: string | null;
    startedAt: string;
  }[];
  arrangements: {
    arrangementId: string;
    role: string;
    lifecycle: string;
    supervising: { workerActive: boolean } | null;
  }[];
  supervision: string | null;
  arrangementPresenceTruncated: boolean;
  milestone: ReturnType<typeof milestoneProjection>;
}
export interface SessionsPayload {
  loadedAt: string;
  status: {
    kind: "missing" | "inactive" | "malformed" | "unsupported" | "active";
    record?: SessionRecord;
  };
  presence: {
    items: PresenceRow[];
    total: number;
    offset: number;
    limit: number;
    unread: number;
    malformed: number;
    unsupported: number;
  };
}
