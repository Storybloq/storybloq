/**
 * The four-way lease classification, extracted so every surface derives it
 * from one computation (ISS-911).
 *
 * The guard's decision matrix turns on live vs expired vs never-established,
 * and an operator misread exactly that during a live recovery because the CLI
 * showed only a relative expiry (N-097, operator 4). `isLeaseExpired` cannot
 * serve: it folds missing, invalid and expired into one `true`, and the
 * difference between "expired" (a determinate observation) and
 * "missing"/"invalid" (never established) is what ISS-897's lease grouping
 * exists to preserve.
 */
import { describe, it, expect } from "vitest";
import { deriveLeaseState } from "../../src/core/session-scan.js";

describe("deriveLeaseState (ISS-911)", () => {
  it("classifies a future expiry as live", () => {
    expect(deriveLeaseState(new Date(Date.now() + 60_000).toISOString())).toBe("live");
  });

  it("classifies a past expiry as expired", () => {
    expect(deriveLeaseState(new Date(Date.now() - 60_000).toISOString())).toBe("expired");
  });

  it("classifies an expiry of exactly NOW as expired, not live", () => {
    // The boundary matters: a lease is a promise of future liveness, and a
    // promise that ends this instant is not one.
    const now = Date.now();
    expect(deriveLeaseState(new Date(now).toISOString(), now)).toBe("expired");
  });

  it("classifies an unparseable string as invalid, never as expired", () => {
    // Invalid is NOT expired: expired is a determinate observation, invalid
    // means nothing was established (ISS-897 lease grouping).
    expect(deriveLeaseState("not-a-date")).toBe("invalid");
  });

  it("classifies absent, null, empty and non-string as missing", () => {
    expect(deriveLeaseState(undefined)).toBe("missing");
    expect(deriveLeaseState(null)).toBe("missing");
    // Empty string is missing, not invalid: this preserves the scanner's
    // original falsy check, which the extraction must not change.
    expect(deriveLeaseState("")).toBe("missing");
    expect(deriveLeaseState(42)).toBe("missing");
  });
});
