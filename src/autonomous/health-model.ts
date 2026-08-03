import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { telemetryDirPath, readOwnerHeartbeat, readLastMcpCall, computeBinaryFingerprint } from "./liveness.js";
import { analyzeSessionDiagnostics } from "./session-diagnostics.js";
import type { EventEntry, FullSessionState } from "./session-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthState =
  | "healthy"
  | "working"
  | "waiting-on-build"
  | "waiting-on-dialog"
  | "telemetry-stale"
  | "stalled"
  | "zombie"
  | "ended"
  | "crashed"
  | "unknown";

export type ProbeValue = boolean | null;

export interface ProbeSnapshot {
  alive: ProbeValue;
  notEnded: ProbeValue;
  mcpResponsive: ProbeValue;
  guideAdvancing: ProbeValue;
  agentActive: ProbeValue;
  subprocessAlive: ProbeValue;
  dialogClear: ProbeValue;
  binaryFresh: ProbeValue;
  lastMcpCallAge: number | null;
  substageAge: number | null;
}

export interface HealthResult {
  sessionId: string;
  healthState: HealthState;
  probes: ProbeSnapshot;
  derivedAt: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Thresholds (ms)
// ---------------------------------------------------------------------------

const ALIVE_THRESHOLD = 30_000;
const MCP_RESPONSIVE_THRESHOLD = 5 * 60 * 1000;
const GUIDE_ADVANCING_THRESHOLD = 15 * 60 * 1000;
const ZOMBIE_THRESHOLD = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure reducer -- no I/O
// ---------------------------------------------------------------------------

export function reduceHealthState(probes: ProbeSnapshot): HealthState {
  const { alive, notEnded, mcpResponsive, guideAdvancing, subprocessAlive, dialogClear, binaryFresh, lastMcpCallAge, substageAge } = probes;

  // healthy: all positive evidence, unknowns (null) allowed for optional probes
  if (
    alive === true &&
    notEnded === true &&
    mcpResponsive === true &&
    guideAdvancing !== false &&
    subprocessAlive !== false &&
    dialogClear !== false &&
    binaryFresh !== false
  ) {
    return "healthy";
  }

  // Terminal states
  if (alive !== true && notEnded === false) return "ended";
  if (alive === false) return "crashed";
  if (alive === null) return "unknown";

  // alive === true from here

  // zombie: all signals silent > 30 min
  if (
    lastMcpCallAge !== null && lastMcpCallAge > ZOMBIE_THRESHOLD &&
    substageAge !== null && substageAge > ZOMBIE_THRESHOLD &&
    mcpResponsive !== true && subprocessAlive !== true
  ) {
    return "zombie";
  }

  // stalled: mcp responsive but guide confirmed not advancing (null = unknown, not stalled)
  if (
    mcpResponsive === true &&
    subprocessAlive !== true &&
    guideAdvancing === false
  ) {
    return "stalled";
  }

  // waiting-on-dialog: explicit false (not null)
  if (dialogClear === false) return "waiting-on-dialog";

  // telemetry-stale: binary drifted AND no other active signals
  // If MCP is responsive or subprocess alive, the session is working despite binary drift
  if (binaryFresh === false && mcpResponsive !== true && subprocessAlive !== true) return "telemetry-stale";

  // waiting-on-build: subprocess running but guide not advancing
  if (subprocessAlive === true && guideAdvancing !== true) return "waiting-on-build";

  // working: at least one active signal
  if (mcpResponsive === true || subprocessAlive === true) return "working";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Probe collection -- reads on-disk state
// ---------------------------------------------------------------------------

function readSessionState(sessionDir: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(sessionDir, "state.json"), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readDiagnosticEvents(sessionDir: string): { events: EventEntry[]; malformedCount: number } {
  try {
    const raw = readFileSync(join(sessionDir, "events.log"), "utf-8");
    const events: EventEntry[] = [];
    let malformedCount = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<EventEntry>;
        if (
          typeof parsed.rev === "number" &&
          typeof parsed.type === "string" &&
          typeof parsed.timestamp === "string" &&
          parsed.data &&
          typeof parsed.data === "object" &&
          !Array.isArray(parsed.data)
        ) {
          events.push(parsed as EventEntry);
        } else {
          malformedCount++;
        }
      } catch {
        malformedCount++;
      }
    }
    return { events, malformedCount };
  } catch {
    return { events: [], malformedCount: 0 };
  }
}

function probeAlive(sessionDir: string, now: number, state: Record<string, unknown> | null): { value: ProbeValue; age: number | null } {
  // T-450 step 7b.4: the OWNER's heartbeat. After a takeover the legacy
  // directory holds the DISPLACED owner's leftovers, so reading it can report a
  // healthy session that nobody is driving.
  //
  // `absent` and `unusable` both map to `null` (unknown), which is what this
  // probe already did for a missing heartbeat -- the health state machine reads
  // `alive === false` as "crashed", and neither "nothing is heartbeating yet"
  // nor "the evidence could not be read" is a crash. They stay apart in the
  // accessor; what this probe adds is that neither is ever reported as a stale
  // timestamp from the wrong owner's directory.
  const heartbeat = readOwnerHeartbeat(sessionDir, state);
  if (heartbeat.kind !== "alive") return { value: null, age: null };
  const age = now - heartbeat.at;
  return { value: age <= ALIVE_THRESHOLD, age };
}

function probeNotEnded(sessionDir: string): ProbeValue {
  const tDir = telemetryDirPath(sessionDir);
  try {
    return !existsSync(join(tDir, "ended"));
  } catch {
    return null;
  }
}

function probeMcpResponsive(sessionDir: string, now: number): { value: ProbeValue; age: number | null } {
  const isoStr = readLastMcpCall(sessionDir);
  if (!isoStr) return { value: null, age: null };
  const ts = new Date(isoStr).getTime();
  if (isNaN(ts)) return { value: null, age: null };
  const age = now - ts;
  return { value: age <= MCP_RESPONSIVE_THRESHOLD, age };
}

function probeGuideAdvancing(state: Record<string, unknown> | null, now: number): { value: ProbeValue; age: number | null } {
  if (!state) return { value: null, age: null };
  const ssAt = state.substageStartedAt;
  if (typeof ssAt !== "string" || !ssAt) return { value: null, age: null };
  const ts = new Date(ssAt).getTime();
  if (isNaN(ts)) return { value: null, age: null };
  const age = now - ts;
  return { value: age <= GUIDE_ADVANCING_THRESHOLD, age };
}

function probeSubprocessAlive(sessionDir: string): ProbeValue {
  const dir = join(telemetryDirPath(sessionDir), "subprocesses");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  if (files.length === 0) return false;

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.pid === "number" && parsed.pid > 0) {
        try {
          process.kill(parsed.pid, 0);
          return true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
        }
      }
    } catch {
      // skip malformed
    }
  }
  return false;
}

let cachedFingerprint: { sha256: string } | null | undefined;
function getCachedFingerprint(): { sha256: string } | null {
  if (cachedFingerprint === undefined) {
    try {
      cachedFingerprint = computeBinaryFingerprint();
    } catch {
      cachedFingerprint = null;
    }
  }
  return cachedFingerprint;
}

function probeBinaryFresh(state: Record<string, unknown> | null): ProbeValue {
  if (!state) return null;
  const stored = state.binaryFingerprint as { sha256?: string } | null | undefined;
  if (!stored?.sha256) return null;
  const current = getCachedFingerprint();
  if (!current) return null;
  return stored.sha256 === current.sha256;
}

export function collectProbes(sessionDir: string, now?: number, preReadState?: Record<string, unknown> | null): ProbeSnapshot {
  const clock = now ?? Date.now();
  const state = preReadState !== undefined ? preReadState : readSessionState(sessionDir);

  const aliveResult = probeAlive(sessionDir, clock, state);
  const mcpResult = probeMcpResponsive(sessionDir, clock);
  const guideResult = probeGuideAdvancing(state, clock);

  return {
    alive: aliveResult.value,
    notEnded: probeNotEnded(sessionDir),
    mcpResponsive: mcpResult.value,
    guideAdvancing: guideResult.value,
    agentActive: null,
    subprocessAlive: probeSubprocessAlive(sessionDir),
    dialogClear: null,
    binaryFresh: probeBinaryFresh(state),
    lastMcpCallAge: mcpResult.age,
    substageAge: guideResult.age,
  };
}

// ---------------------------------------------------------------------------
// Full derivation
// ---------------------------------------------------------------------------

export function deriveHealthState(sessionDir: string): HealthResult {
  const state = readSessionState(sessionDir);
  const sessionId = (state?.sessionId as string) ?? basename(sessionDir);
  const probes = collectProbes(sessionDir, undefined, state);
  const healthState = reduceHealthState(probes);
  let diagnosticSummary: ReturnType<typeof analyzeSessionDiagnostics> | null = null;
  if (state) {
    try {
      diagnosticSummary = analyzeSessionDiagnostics(
        state as FullSessionState,
        readDiagnosticEvents(sessionDir),
      );
    } catch {
      // Health remains available for corrupt or partially written legacy state.
    }
  }

  return {
    sessionId,
    healthState,
    probes,
    derivedAt: new Date().toISOString(),
    details: diagnosticSummary && diagnosticSummary.diagnostics.length > 0
      ? {
          diagnostics: diagnosticSummary.diagnostics,
          codeReview: {
            rounds: diagnosticSummary.codeReviewRounds,
            backtracks: diagnosticSummary.codeReviewBacktracks,
            maxReviewRounds: diagnosticSummary.maxReviewRounds,
            lastVerdict: diagnosticSummary.lastVerdict,
            lastCriticalCount: diagnosticSummary.lastCriticalCount,
            lastUnresolvedCriticalCount: diagnosticSummary.lastUnresolvedCriticalCount,
            lastMajorCount: diagnosticSummary.lastMajorCount,
            ticketAgeMs: diagnosticSummary.ticketAgeMs,
            filedDeferralCount: diagnosticSummary.filedDeferralCount,
          },
        }
      : {},
  };
}
