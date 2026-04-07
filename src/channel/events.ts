/**
 * Channel event schemas and formatting.
 *
 * Defines the event types that the Mac app can push to Claude Code
 * via the file-based IPC inbox (.story/channel-inbox/).
 */
import { z } from "zod";

// MARK: - Event Schemas

const TicketRequestedPayload = z.object({
  ticketId: z.string().regex(/^T-\d+[a-z]?$/),
});

const PauseSessionPayload = z.object({});

const ResumeSessionPayload = z.object({});

const CancelSessionPayload = z.object({
  reason: z.string().max(1000).optional(),
});

const PriorityChangedPayload = z.object({
  ticketId: z.string().regex(/^T-\d+[a-z]?$/),
  newOrder: z.number().int(),
});

const PermissionResponsePayload = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9]{5}$/),
  behavior: z.enum(["approve", "deny"]),
});

export const ChannelEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("ticket_requested"),
    timestamp: z.string(),
    payload: TicketRequestedPayload,
  }),
  z.object({
    event: z.literal("pause_session"),
    timestamp: z.string(),
    payload: PauseSessionPayload,
  }),
  z.object({
    event: z.literal("resume_session"),
    timestamp: z.string(),
    payload: ResumeSessionPayload,
  }),
  z.object({
    event: z.literal("cancel_session"),
    timestamp: z.string(),
    payload: CancelSessionPayload,
  }),
  z.object({
    event: z.literal("priority_changed"),
    timestamp: z.string(),
    payload: PriorityChangedPayload,
  }),
  z.object({
    event: z.literal("permission_response"),
    timestamp: z.string(),
    payload: PermissionResponsePayload,
  }),
]);

export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

// MARK: - Filename Validation

/** Pattern for valid inbox filenames: ISO-ish timestamp + event type + .json */
const VALID_FILENAME = /^[\d]{4}-[\d]{2}-[\d]{2}T[\w.:-]+-[\w]+\.json$/;

/**
 * Validates an inbox filename is safe (no path traversal, matches expected pattern).
 * Returns true if the filename is safe to process.
 */
export function isValidInboxFilename(filename: string): boolean {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return false;
  }
  return VALID_FILENAME.test(filename);
}

// MARK: - Content Formatting

/**
 * Produces a human-readable content string for the channel notification.
 * Claude reads this content directly.
 */
export function formatChannelContent(event: ChannelEvent): string {
  switch (event.event) {
    case "ticket_requested":
      return `User requested ticket ${event.payload.ticketId} be started.`;
    case "pause_session":
      return "User requested the autonomous session be paused.";
    case "resume_session":
      return "User requested the autonomous session be resumed.";
    case "cancel_session": {
      const reason = event.payload.reason ? ` Reason: ${event.payload.reason}` : "";
      return `User requested the autonomous session be cancelled.${reason}`;
    }
    case "priority_changed":
      return `User changed priority of ticket ${event.payload.ticketId} to order ${event.payload.newOrder}.`;
    case "permission_response":
      return `Permission response for request ${event.payload.requestId}: ${event.payload.behavior}.`;
  }
}

/**
 * Produces structured metadata for the channel notification.
 * All values must be strings per the MCP channel protocol.
 */
export function formatChannelMeta(event: ChannelEvent): Record<string, string> {
  const meta: Record<string, string> = { event: event.event };
  switch (event.event) {
    case "ticket_requested":
      meta.ticketId = event.payload.ticketId;
      break;
    case "cancel_session":
      if (event.payload.reason) meta.reason = event.payload.reason;
      break;
    case "priority_changed":
      meta.ticketId = event.payload.ticketId;
      meta.newOrder = String(event.payload.newOrder);
      break;
    case "permission_response":
      meta.requestId = event.payload.requestId;
      meta.behavior = event.payload.behavior;
      break;
  }
  return meta;
}
