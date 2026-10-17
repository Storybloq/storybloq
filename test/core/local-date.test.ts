/**
 * ISS-1383: `localDateOf` is the one way the CLI turns an instant into a
 * date-only field: the Gregorian local calendar date, zero padded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDateOf } from "../../src/core/local-date.js";
import { todayISO } from "../../src/cli/helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("localDateOf", () => {
  it("U1a: zero pads month and day", () => {
    vi.stubEnv("TZ", "UTC");
    expect(localDateOf(new Date("2026-01-05T12:00:00Z"))).toBe("2026-01-05");
  });

  it("U1b: crosses the year boundary by the local zone, not UTC", () => {
    vi.stubEnv("TZ", "Pacific/Kiritimati");
    const instant = new Date("2026-12-31T10:30:00Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(localDateOf(instant)).toBe("2027-01-01");
  });

  it("U1c: a western zone reads the previous day", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(localDateOf(new Date("2026-03-10T05:30:00Z"))).toBe("2026-03-09");
  });

  it("U1d: todayISO is localDateOf at the current instant", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T05:30:00Z"));
    expect(todayISO()).toBe("2026-03-09");
  });
});
