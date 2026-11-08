// T-538 S5b-0 commit 5: section 12's limits as one versioned manifest, with section 11's budget and the
// M7 rulings (plan v10, line 908). Any increase of a ruled number needs a pen ruling after the pilot.
// Nothing calls this yet; the conversion commit does.

const MIB = 1 << 20;
const GIB = 1 << 30;
const MIN = 60_000;

export const LIMITS_VERSION = 1;

export const LIMITS = {
  version: LIMITS_VERSION,
  memoryBytes: 2 * GIB,
  pids: 512,
  cpus: 2,
  tmpBytes: 256 * MIB,
  diskTickMs: 1_000,
  /** M7: the disk monitor always uses docker kill; Sharge's worst one-second rate sets its threshold. */
  volumes: {
    sharge: { stopThresholdBytes: Math.round(13.9 * GIB), launchReserveBytes: Math.round(27.8 * GIB) },
    hostData: { stopThresholdBytes: Math.round(4.5 * GIB), launchReserveBytes: 10 * GIB },
  },
  attemptVolumeGrowthBytes: 2 * GIB,
  dfMissesToStop: 3,
  dfCallTimeoutMs: 5_000,
  turnStdoutBytes: 64 * MIB,
  turnStderrBytes: 8 * MIB,
  attemptCaptureBytes: 256 * MIB,
  attemptDeadlineMs: 210 * MIN,
  budgetEndMs: 237 * MIN,
  cleanupMarginMs: 2 * MIN,
  turnTimeoutMs: 40 * MIN,
  watchdogGraceMs: 60_000,
  reviewerLaunches: 8,
  stopAfterDetectionMs: 15_000,
  proxyConnections: 100,
  proxyUpstreamBytes: 256 * MIB,
  connectionLifetimeMs: 45 * MIN,
  proxyExpiryAfterDeadlineMs: MIN,
  proxySockets: 32,
  proxyHeaderMs: 10_000,
  proxyHeaderBytes: 8 * 1024,
  execStdinBytes: 16 * MIB,
  packDeadlineCapMs: 20 * MIN,
  proxyPackDeadlineCapMs: 2 * MIN,
  stopCapMs: 25_000,
  proxyLogBytes: 16 * MIB,
  packRecordBytes: 8 * MIB,
  checkpoint: { recordBytes: MIB, packetBytes: 2 * MIB, reviewerOutputBytes: 4 * MIB, aggregateBytes: 64 * MIB },
  judgeProxy: { connections: 50, upstreamBytes: 256 * MIB },
  /** Section 11: an operation with less than this available is not started; a retry needs the next. */
  minOperationMs: 60_000,
  minRetryMs: 5 * MIN,
  monitorTickStallMs: 5_000,
  quarantineReportAfterMs: 7 * 24 * 60 * MIN,
} as const;

export type Limits = typeof LIMITS;

/** Section 11's absolute times, measured from the box lease's start. */
export interface Budget {
  readonly leaseStart: number;
  readonly attemptDeadline: number;
  readonly proxyExpiry: number;
  readonly budgetEnd: number;
}
export function budgetFrom(leaseStart: number, l: Limits = LIMITS): Budget {
  const attemptDeadline = leaseStart + l.attemptDeadlineMs;
  return { leaseStart, attemptDeadline, proxyExpiry: attemptDeadline + l.proxyExpiryAfterDeadlineMs, budgetEnd: leaseStart + l.budgetEndMs };
}

/** PID 1's sleep at launch: the deadline less the time already spent, in whole seconds, never below zero. */
export function pid1SleepSeconds(b: Budget, now: number): number {
  return Math.max(0, Math.floor((b.attemptDeadline - now) / 1000));
}

/**
 * One post-stop operation's deadline: the smaller of its cap and the time to the budget end less the
 * cleanup margin. Null when under the minimum is available: the operation is not started.
 */
export function operationDeadline(b: Budget, now: number, capMs: number, l: Limits = LIMITS): number | null {
  const available = b.budgetEnd - l.cleanupMarginMs - now;
  if (available < l.minOperationMs) return null;
  return now + Math.min(capMs, available);
}

/** A retry runs only if the minimum retry time remains after the failed try's removal. */
export function retryAllowed(b: Budget, now: number, l: Limits = LIMITS): boolean {
  return b.budgetEnd - l.cleanupMarginMs - now >= l.minRetryMs;
}

/** The pack deadline passed to pack.sh, in whole seconds, or null when the pack must not start. */
export function packDeadlineSeconds(b: Budget, now: number, profile: "attempt" | "judge" | "live" | "proxy", l: Limits = LIMITS): number | null {
  const cap = profile === "proxy" ? l.proxyPackDeadlineCapMs : l.packDeadlineCapMs;
  const at = operationDeadline(b, now, cap, l);
  return at === null ? null : Math.floor((at - now) / 1000);
}

/** Section 12's launch check: each volume's free space at or above its reserve; the refusal names the figure. */
export function launchRefusal(free: { readonly sharge: number; readonly hostData: number }, l: Limits = LIMITS): string | null {
  for (const v of ["sharge", "hostData"] as const) {
    const need = l.volumes[v].launchReserveBytes;
    if (free[v] < need) return `${v} has ${(free[v] / GIB).toFixed(1)} GiB free, under its launch reserve of ${(need / GIB).toFixed(1)} GiB`;
  }
  return null;
}
