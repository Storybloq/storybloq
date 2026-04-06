/**
 * PTY permission parser contract tests (T-215).
 *
 * Validates the format expectations for PTY-sourced permission requests.
 * The actual parsing is implemented in Swift -- these tests document
 * the cross-platform contract for requestId format and gate behavior.
 */
import { describe, it, expect } from "vitest";

/**
 * PTY-sourced permission requests use UUID-format requestIds to distinguish
 * from channel-sourced requests (5-letter alphanumeric).
 */
describe("PTY Permission Contract (T-215)", () => {
  it("isPtyRequestId returns true for UUID-format IDs", async () => {
    const { isPtyRequestId } = await import("../../src/channel/pty-permission-contract.js");
    expect(isPtyRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("isPtyRequestId returns false for channel-format IDs", async () => {
    const { isPtyRequestId } = await import("../../src/channel/pty-permission-contract.js");
    expect(isPtyRequestId("aB3xZ")).toBe(false);
  });

  it("isPtyRequestId returns false for empty string", async () => {
    const { isPtyRequestId } = await import("../../src/channel/pty-permission-contract.js");
    expect(isPtyRequestId("")).toBe(false);
  });

  it("isChannelRequestId returns true for 5-letter alphanumeric IDs", async () => {
    const { isChannelRequestId } = await import("../../src/channel/pty-permission-contract.js");
    expect(isChannelRequestId("aB3xZ")).toBe(true);
  });

  it("isChannelRequestId returns false for UUID-format IDs", async () => {
    const { isChannelRequestId } = await import("../../src/channel/pty-permission-contract.js");
    expect(isChannelRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("identifies permission source from requestId format", async () => {
    const { permissionSourceFromRequestId } = await import("../../src/channel/pty-permission-contract.js");
    expect(permissionSourceFromRequestId("aB3xZ")).toBe("channel");
    expect(permissionSourceFromRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe("pty");
    expect(permissionSourceFromRequestId("invalid")).toBe("unknown");
  });
});
