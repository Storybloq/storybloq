/**
 * Companion protocol message types.
 *
 * Defines the JSON message shapes exchanged between the Mac app
 * (CompanionServer) and iOS app (ConnectionManager) over WebSocket.
 * The actual encoding/decoding is implemented in Swift -- these types
 * serve as cross-platform contract documentation.
 */

export interface CapabilitiesMessage {
  type: "capabilities";
  channelAvailable: boolean;
  permissionRelayAvailable: boolean;
}

/**
 * Parses and validates a raw JSON string as a CapabilitiesMessage.
 * Returns the typed message or null if invalid.
 */
export function parseCapabilitiesMessage(raw: string): CapabilitiesMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    obj.type === "capabilities" &&
    typeof obj.channelAvailable === "boolean" &&
    typeof obj.permissionRelayAvailable === "boolean"
  ) {
    return {
      type: "capabilities",
      channelAvailable: obj.channelAvailable,
      permissionRelayAvailable: obj.permissionRelayAvailable,
    };
  }
  return null;
}
