/**
 * T-481 T11: the aging helper and its config. Age is whole local days since
 * updatedDate, falling back to the birth date (createdDate for tickets,
 * discoveredDate for issues), floored at 0. No consumer uses it yet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGING_DEFAULTS, ageDays, agingConfig } from "../../src/core/aging.js";
import { ConfigSchema } from "../../src/models/config.js";
import { makeIssue, makeTicket, minimalConfig } from "./test-factories.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("T-481 T11: ageDays", () => {
  const now = new Date(2026, 9, 17, 12, 0, 0); // local 2026-10-17 noon

  it("uses updatedDate when present", () => {
    expect(ageDays(makeTicket({ id: "T-001", createdDate: "2026-01-01", updatedDate: "2026-10-10" } as never), now)).toBe(7);
  });

  it("falls back to createdDate for a ticket and discoveredDate for an issue", () => {
    expect(ageDays(makeTicket({ id: "T-001", createdDate: "2026-10-07" }), now)).toBe(10);
    expect(ageDays(makeIssue({ id: "ISS-001", discoveredDate: "2026-10-14" }), now)).toBe(3);
    expect(ageDays(makeIssue({ id: "ISS-001", discoveredDate: "2026-01-01", updatedDate: "2026-10-16" } as never), now)).toBe(1);
  });

  it("is floored at 0 for a future date", () => {
    expect(ageDays(makeTicket({ id: "T-001", createdDate: "2026-01-01", updatedDate: "2026-12-01" } as never), now)).toBe(0);
  });

  it("counts local calendar days across a local midnight", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // 2026-03-10T05:30Z is local 2026-03-09 22:30: an item updated on 03-09 is 0 days old.
    const late = new Date("2026-03-10T05:30:00.000Z");
    expect(ageDays(makeTicket({ id: "T-001", createdDate: "2026-01-01", updatedDate: "2026-03-09" } as never), late)).toBe(0);
    expect(ageDays(makeTicket({ id: "T-001", createdDate: "2026-01-01", updatedDate: "2026-03-08" } as never), late)).toBe(1);
  });
});

describe("T-481 T11: agingConfig", () => {
  it("defaults", () => {
    expect(AGING_DEFAULTS).toEqual({
      staleInProgressDays: 14, staleCriticalIssueDays: 30, agingIssueDays: 90,
      agingIssueBoostPerMonth: 20, agingStaleInProgressPenalty: 150,
    });
    expect(agingConfig(minimalConfig)).toEqual(AGING_DEFAULTS);
  });

  it("merges recipeOverrides and the config schema accepts the keys", () => {
    const config = ConfigSchema.parse({ ...minimalConfig, recipeOverrides: { staleInProgressDays: 7, agingIssueDays: 0 } });
    expect(agingConfig(config)).toEqual({ ...AGING_DEFAULTS, staleInProgressDays: 7, agingIssueDays: 0 });
    expect(ConfigSchema.safeParse({ ...minimalConfig, recipeOverrides: { staleInProgressDays: -1 } }).success).toBe(false);
  });
});
