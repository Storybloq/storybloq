/**
 * ISS-076: MCP server version mismatch advisory.
 * Tests the checkVersionMismatch helper that compares running vs installed version.
 */
import { describe, it, expect } from "vitest";
import { checkVersionMismatch } from "../../src/autonomous/version-check.js";

describe("ISS-076: version mismatch advisory", () => {
  it("returns null when versions match", () => {
    const result = checkVersionMismatch("0.1.41", "0.1.41");
    expect(result).toBeNull();
  });

  it("returns warning string when versions differ", () => {
    const result = checkVersionMismatch("0.1.40", "0.1.41");
    expect(result).not.toBeNull();
    expect(result).toContain("0.1.40");
    expect(result).toContain("0.1.41");
    expect(result).toContain("Restart");
  });

  it("returns null when installed version cannot be resolved (null)", () => {
    const result = checkVersionMismatch("0.1.41", null);
    expect(result).toBeNull();
  });

  it("returns null when running version is dev fallback", () => {
    const result = checkVersionMismatch("0.0.0-dev", "0.1.41");
    expect(result).toBeNull();
  });
});
