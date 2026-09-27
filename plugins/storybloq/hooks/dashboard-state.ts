import { DashboardMotion } from "./dashboard-motion.js";
import type { SidebarProjection, SidebarRecord } from "./sidebar-projection.js";
export interface CachedRecord {
  readonly mtimeMs: number;
  readonly record: SidebarRecord;
}
export interface ScanItem {
  readonly path: string;
  readonly kind: "ticket" | "issue";
}
/** Owned by one registration; host callbacks retain their own instance. */
export interface DashboardState {
  cache: Record<string, CachedRecord>;
  cacheLoaded: boolean;
  projection: SidebarProjection | null;
  project: string;
  phases: {
    readonly id: string;
    readonly name: string;
    readonly label?: string;
  }[];
  handoverFilenames: string[];
  queue: ScanItem[];
  idleTicks: number;
  polledMtimes: Record<string, number>;
  scanInitializing: boolean;
  scanActive: boolean;
  pendingRefresh: boolean;
  ticking: boolean;
  timerStarted: boolean;
  logoElapsed: number;
  logoStarted: boolean;
  logoFinished: boolean;
  logoTicks: number;
  motion: DashboardMotion;
  bandDrawn: boolean;
  sidebarEnabled: boolean;
  paneOpen: boolean;
  paneDrawn: boolean;
  reopenAsked: boolean;
  themeLight: boolean;
  paneInline: boolean;
  sessionActive: boolean;
  /** T-531: status.json's `state`, `ticket`, `claudeStatus` and `observedAt`; null when absent or malformed. */
  sessionState: string | null;
  sessionTicket: string | null;
  sessionClaudeStatus: string | null;
  sessionObservedAt: string | null;
  /**
   * T-532: status.json's `currentIssue`, which ISSUE_FIX carries in place of
   * `ticket`. `sessionIssue` is its display id, falling back to its id;
   * `sessionIssueId` is the id alone. Null when absent or malformed.
   */
  sessionIssue: string | null;
  sessionIssueId: string | null;
  contextPercent: number | null;
  /** T-532: when a tool call last read the context fill; null before the first. */
  contextReadAt: number | null;
  /**
   * T-532: bumped by every context read and every session start. A read's
   * result is applied only while its number is still the latest. Monotonic:
   * never reset.
   */
  contextSeq: number;
  warm: boolean;
  uiAvailable: boolean;
  noLedger: boolean;
  saidNoUi: boolean;
  saidNoLedger: boolean;
  saidScanFailed: boolean;
  saidRootUnresolved: boolean;
  /**
   * T-537: the origins the setup hint has already been given for. Once per
   * session and root, so unlike the said-once flags it is NOT cleared by a
   * reload's session start: the same root stays quiet, a new one speaks once.
   */
  setupHintRoots: Set<string>;
  initialCwd: string | null;
  ledgerRoot: string | null;
}
export function createDashboardState(): DashboardState {
  return {
    cache: {},
    cacheLoaded: false,
    projection: null,
    project: "",
    phases: [],
    handoverFilenames: [],
    queue: [],
    idleTicks: 0,
    polledMtimes: {},
    scanInitializing: false,
    scanActive: false,
    pendingRefresh: false,
    ticking: false,
    timerStarted: false,
    logoElapsed: 0,
    logoStarted: false,
    logoFinished: false,
    logoTicks: 0,
    motion: new DashboardMotion(),
    bandDrawn: false,
    sidebarEnabled: false,
    paneOpen: false,
    paneDrawn: false,
    reopenAsked: false,
    themeLight: false,
    paneInline: false,
    sessionActive: false,
    sessionState: null,
    sessionTicket: null,
    sessionClaudeStatus: null,
    sessionObservedAt: null,
    sessionIssue: null,
    sessionIssueId: null,
    contextPercent: null,
    contextReadAt: null,
    contextSeq: 0,
    warm: false,
    uiAvailable: true,
    noLedger: false,
    saidNoUi: false,
    saidNoLedger: false,
    saidScanFailed: false,
    saidRootUnresolved: false,
    setupHintRoots: new Set(),
    initialCwd: null,
    ledgerRoot: null,
  };
}
