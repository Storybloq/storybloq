/**
 * Companion protocol contract tests.
 *
 * These tests validate the JSON message shapes exchanged between the Mac app
 * (CompanionServer) and iOS app (ConnectionManager) over WebSocket.
 *
 * The actual encoding/decoding is implemented in Swift. These tests serve as
 * cross-platform contract documentation and validation.
 */
import { describe, it, expect } from "vitest";
import { parseCapabilitiesMessage } from "../../src/channel/companion-protocol.js";

describe("Companion Protocol - Capabilities Message (T-221)", () => {
  it("validates a well-formed capabilities message", () => {
    const result = parseCapabilitiesMessage(
      '{"type":"capabilities","channelAvailable":true,"permissionRelayAvailable":false}',
    );
    expect(result).toEqual({
      type: "capabilities",
      channelAvailable: true,
      permissionRelayAvailable: false,
    });
  });

  it("rejects message with missing channelAvailable", () => {
    expect(
      parseCapabilitiesMessage('{"type":"capabilities","permissionRelayAvailable":false}'),
    ).toBeNull();
  });

  it("rejects message with missing permissionRelayAvailable", () => {
    expect(
      parseCapabilitiesMessage('{"type":"capabilities","channelAvailable":true}'),
    ).toBeNull();
  });

  it("rejects message with wrong type", () => {
    expect(
      parseCapabilitiesMessage(
        '{"type":"status","channelAvailable":true,"permissionRelayAvailable":false}',
      ),
    ).toBeNull();
  });

  it("rejects non-boolean field values", () => {
    expect(
      parseCapabilitiesMessage(
        '{"type":"capabilities","channelAvailable":"yes","permissionRelayAvailable":1}',
      ),
    ).toBeNull();
  });

  it("accepts both-false capabilities (default state)", () => {
    const result = parseCapabilitiesMessage(
      '{"type":"capabilities","channelAvailable":false,"permissionRelayAvailable":false}',
    );
    expect(result).toEqual({
      type: "capabilities",
      channelAvailable: false,
      permissionRelayAvailable: false,
    });
  });

  it("accepts both-true capabilities (fully available)", () => {
    const result = parseCapabilitiesMessage(
      '{"type":"capabilities","channelAvailable":true,"permissionRelayAvailable":true}',
    );
    expect(result).toEqual({
      type: "capabilities",
      channelAvailable: true,
      permissionRelayAvailable: true,
    });
  });

  it("ignores extra fields (forward compatibility)", () => {
    const result = parseCapabilitiesMessage(
      '{"type":"capabilities","channelAvailable":true,"permissionRelayAvailable":false,"futureField":"ignored"}',
    );
    expect(result).toEqual({
      type: "capabilities",
      channelAvailable: true,
      permissionRelayAvailable: false,
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseCapabilitiesMessage("not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseCapabilitiesMessage('"just a string"')).toBeNull();
    expect(parseCapabilitiesMessage("42")).toBeNull();
    expect(parseCapabilitiesMessage("null")).toBeNull();
  });
});
