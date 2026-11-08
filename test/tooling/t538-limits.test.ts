// T-538 S5b-0 commit 5: section 12's manifest and section 11's budget arithmetic, on a fake clock.
import { describe, expect, it } from "vitest";
import { budgetFrom, launchRefusal, LIMITS, operationDeadline, packDeadlineSeconds, pid1SleepSeconds, retryAllowed } from "../../scripts/onboarding-eval-limits.js";

const MIN = 60_000;
const GIB = 1 << 30;
const T0 = 1_800_000_000_000;

describe("section 12's ruled numbers", () => {
  it("are the manifest's, versioned", () => {
    expect(LIMITS.version).toBe(1);
    expect([LIMITS.memoryBytes, LIMITS.pids, LIMITS.cpus, LIMITS.diskTickMs]).toEqual([2 * GIB, 512, 2, 1000]);
    expect([LIMITS.turnStdoutBytes, LIMITS.turnStderrBytes, LIMITS.attemptCaptureBytes]).toEqual([64 << 20, 8 << 20, 256 << 20]);
    expect([LIMITS.proxyConnections, LIMITS.proxySockets, LIMITS.execStdinBytes, LIMITS.reviewerLaunches, LIMITS.stopAfterDetectionMs]).toEqual([100, 32, 16 << 20, 8, 15_000]);
  });
  it("carry M7's rulings: Sharge 13.9 GiB stop and 27.8 GiB reserve, host data 4.5 GiB and 10 GiB", () => {
    expect(LIMITS.volumes.sharge.stopThresholdBytes / GIB).toBeCloseTo(13.9, 6);
    expect(LIMITS.volumes.sharge.launchReserveBytes / GIB).toBeCloseTo(27.8, 6);
    expect([LIMITS.volumes.hostData.stopThresholdBytes / GIB, LIMITS.volumes.hostData.launchReserveBytes / GIB]).toEqual([4.5, 10]);
  });
});

describe("section 11's budget, from the lease start", () => {
  const b = budgetFrom(T0);
  it("deadline +210 min, proxy expiry one minute later, budget end +237 min", () => {
    expect([b.attemptDeadline - T0, b.proxyExpiry - T0, b.budgetEnd - T0]).toEqual([210 * MIN, 211 * MIN, 237 * MIN]);
  });
  it("a late launch shortens PID 1's sleep by the time already spent, never below zero", () => {
    expect(pid1SleepSeconds(b, T0)).toBe(210 * 60);
    expect(pid1SleepSeconds(b, T0 + 30 * MIN + 500)).toBe(180 * 60 - 1);
    expect(pid1SleepSeconds(b, T0 + 300 * MIN)).toBe(0);
  });
  it("each operation gets the smaller of its cap and what remains less the cleanup margin", () => {
    expect(operationDeadline(b, T0 + 100 * MIN, 20 * MIN)).toBe(T0 + 120 * MIN);
    // 237 - 2 - 230 = 5 minutes left: the 20 min pack gets 5.
    expect(operationDeadline(b, T0 + 230 * MIN, 20 * MIN)).toBe(T0 + 235 * MIN);
  });
  it("an operation with under 60 s available is not started; exactly 60 s is", () => {
    expect(operationDeadline(b, T0 + 234 * MIN + 1, 20 * MIN)).toBeNull();
    expect(operationDeadline(b, T0 + 234 * MIN, 20 * MIN)).toBe(T0 + 235 * MIN);
  });
  it("a retry needs 5 minutes after the failed try's removal", () => {
    expect(retryAllowed(b, T0 + 230 * MIN)).toBe(true);
    expect(retryAllowed(b, T0 + 230 * MIN + 1)).toBe(false);
  });
  it("the worst case at the deadline leaves no retry: 25 s stop, 2 min proxy, 20 min pack", () => {
    const afterPack = b.attemptDeadline + 25_000 + 2 * MIN + 20 * MIN;
    expect(retryAllowed(b, afterPack)).toBe(false);
  });
  it("pack.sh gets the shorter deadline in seconds: 1200 capped, 120 for the proxy, null when it cannot start", () => {
    expect(packDeadlineSeconds(b, T0, "attempt")).toBe(1200);
    expect(packDeadlineSeconds(b, T0, "proxy")).toBe(120);
    expect(packDeadlineSeconds(b, T0 + 225 * MIN, "attempt")).toBe(600);
    expect(packDeadlineSeconds(b, T0 + 235 * MIN, "live")).toBeNull();
  });
});

describe("the launch reserve", () => {
  it("refuses under either volume's reserve and names the figure", () => {
    expect(launchRefusal({ sharge: 30 * GIB, hostData: 20 * GIB })).toBeNull();
    expect(launchRefusal({ sharge: 20 * GIB, hostData: 20 * GIB })).toBe("sharge has 20.0 GiB free, under its launch reserve of 27.8 GiB");
    expect(launchRefusal({ sharge: 30 * GIB, hostData: 9 * GIB })).toBe("hostData has 9.0 GiB free, under its launch reserve of 10.0 GiB");
  });
  it("exactly the reserve launches; one byte under does not", () => {
    const sh = LIMITS.volumes.sharge.launchReserveBytes;
    const hd = LIMITS.volumes.hostData.launchReserveBytes;
    expect(launchRefusal({ sharge: sh, hostData: hd })).toBeNull();
    expect(launchRefusal({ sharge: sh - 1, hostData: hd })).toContain("sharge has");
    expect(launchRefusal({ sharge: sh, hostData: hd - 1 })).toContain("hostData has");
  });
});
