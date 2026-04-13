import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * T-245: iOS View Layer Hardening -- contract markers.
 * These tests verify the iOS-side artifacts exist after implementation.
 * They must FAIL before implementation and PASS after.
 */
describe("T-245 iOS View Layer Hardening", () => {
  const iosRoot = resolve(__dirname, "../../iOS/Story");

  it("ISS-320: QRPairingHandler shared helper exists", () => {
    expect(existsSync(resolve(iosRoot, "Core/QRPairingHandler.swift"))).toBe(true);
  });

  it("ISS-320: DiagnosticsCollector shared helper exists", () => {
    expect(existsSync(resolve(iosRoot, "Core/DiagnosticsCollector.swift"))).toBe(true);
  });
});
