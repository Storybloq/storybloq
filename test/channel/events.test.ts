import { describe, it, expect } from "vitest";
import { ChannelEventSchema, isValidInboxFilename, formatChannelContent, formatChannelMeta } from "../../src/channel/events.js";

describe("ChannelEventSchema", () => {
  it("parses ticket_requested event", () => {
    const data = {
      event: "ticket_requested",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { ticketId: "T-001" },
    };
    const result = ChannelEventSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event).toBe("ticket_requested");
      expect(result.data.payload).toEqual({ ticketId: "T-001" });
    }
  });

  it("parses pause_session event", () => {
    const result = ChannelEventSchema.safeParse({
      event: "pause_session",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: {},
    });
    expect(result.success).toBe(true);
  });

  it("parses resume_session event", () => {
    const result = ChannelEventSchema.safeParse({
      event: "resume_session",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: {},
    });
    expect(result.success).toBe(true);
  });

  it("parses cancel_session with reason", () => {
    const result = ChannelEventSchema.safeParse({
      event: "cancel_session",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { reason: "User changed mind" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({ reason: "User changed mind" });
    }
  });

  it("parses cancel_session without reason", () => {
    const result = ChannelEventSchema.safeParse({
      event: "cancel_session",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: {},
    });
    expect(result.success).toBe(true);
  });

  it("parses priority_changed event", () => {
    const result = ChannelEventSchema.safeParse({
      event: "priority_changed",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { ticketId: "T-050", newOrder: 3 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({ ticketId: "T-050", newOrder: 3 });
    }
  });

  it("parses permission_response event", () => {
    const data = {
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { requestId: "aBc12", behavior: "approve" },
    };
    const result = ChannelEventSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event).toBe("permission_response");
      expect(result.data.payload).toEqual({ requestId: "aBc12", behavior: "approve" });
    }
  });

  it("parses permission_response with deny behavior", () => {
    const result = ChannelEventSchema.safeParse({
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { requestId: "xYz99", behavior: "deny" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects permission_response with invalid requestId format", () => {
    const result = ChannelEventSchema.safeParse({
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { requestId: "toolong123", behavior: "approve" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects permission_response with invalid behavior", () => {
    const result = ChannelEventSchema.safeParse({
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { requestId: "aBc12", behavior: "maybe" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown event type", () => {
    const result = ChannelEventSchema.safeParse({
      event: "unknown_event",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const result = ChannelEventSchema.safeParse({
      event: "pause_session",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid ticketId format", () => {
    const result = ChannelEventSchema.safeParse({
      event: "ticket_requested",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { ticketId: "INVALID" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer newOrder", () => {
    const result = ChannelEventSchema.safeParse({
      event: "priority_changed",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { ticketId: "T-001", newOrder: 3.5 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts suffixed ticket IDs", () => {
    const result = ChannelEventSchema.safeParse({
      event: "ticket_requested",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { ticketId: "T-005a" },
    });
    expect(result.success).toBe(true);
  });
});

describe("isValidInboxFilename", () => {
  it("accepts valid timestamp-event filenames", () => {
    expect(isValidInboxFilename("2026-04-05T10:00:00.000Z-ticket_requested.json")).toBe(true);
    expect(isValidInboxFilename("2026-04-05T10:00:00Z-pause_session.json")).toBe(true);
  });

  it("rejects path traversal with ..", () => {
    expect(isValidInboxFilename("../etc/passwd.json")).toBe(false);
    expect(isValidInboxFilename("..%2F..%2Fetc.json")).toBe(false);
  });

  it("rejects path separators", () => {
    expect(isValidInboxFilename("foo/bar.json")).toBe(false);
    expect(isValidInboxFilename("foo\\bar.json")).toBe(false);
  });

  it("rejects non-json files", () => {
    expect(isValidInboxFilename("2026-04-05T10:00:00Z-event.txt")).toBe(false);
  });

  it("rejects hidden files", () => {
    expect(isValidInboxFilename(".hidden.json")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidInboxFilename("")).toBe(false);
  });
});

describe("formatChannelContent -- permission_response", () => {
  it("formats permission_response approve", () => {
    const content = formatChannelContent({
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { requestId: "aBc12", behavior: "approve" },
    } as any);
    expect(content).toContain("aBc12");
    expect(content).toContain("approve");
  });

  it("formats permission_response deny", () => {
    const content = formatChannelContent({
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { requestId: "xYz99", behavior: "deny" },
    } as any);
    expect(content).toContain("deny");
  });
});

describe("formatChannelMeta -- permission_response", () => {
  it("includes requestId and behavior", () => {
    const meta = formatChannelMeta({
      event: "permission_response",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { requestId: "aBc12", behavior: "approve" },
    } as any);
    expect(meta.event).toBe("permission_response");
    expect(meta.requestId).toBe("aBc12");
    expect(meta.behavior).toBe("approve");
  });
});

describe("formatChannelContent", () => {
  it("formats ticket_requested", () => {
    const content = formatChannelContent({
      event: "ticket_requested",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { ticketId: "T-001" },
    });
    expect(content).toBe("User requested ticket T-001 be started.");
  });

  it("formats pause_session", () => {
    const content = formatChannelContent({
      event: "pause_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: {},
    });
    expect(content).toContain("paused");
  });

  it("formats resume_session", () => {
    const content = formatChannelContent({
      event: "resume_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: {},
    });
    expect(content).toContain("resumed");
  });

  it("formats cancel_session with reason", () => {
    const content = formatChannelContent({
      event: "cancel_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { reason: "Too slow" },
    });
    expect(content).toContain("cancelled");
    expect(content).toContain("Too slow");
  });

  it("formats cancel_session without reason", () => {
    const content = formatChannelContent({
      event: "cancel_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: {},
    });
    expect(content).toContain("cancelled");
    expect(content).not.toContain("Reason");
  });

  it("formats priority_changed", () => {
    const content = formatChannelContent({
      event: "priority_changed",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { ticketId: "T-050", newOrder: 3 },
    });
    expect(content).toContain("T-050");
    expect(content).toContain("3");
  });
});

describe("formatChannelMeta", () => {
  it("includes event type for all events", () => {
    const meta = formatChannelMeta({
      event: "pause_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: {},
    });
    expect(meta.event).toBe("pause_session");
  });

  it("includes ticketId for ticket_requested", () => {
    const meta = formatChannelMeta({
      event: "ticket_requested",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { ticketId: "T-001" },
    });
    expect(meta.ticketId).toBe("T-001");
  });

  it("includes reason for cancel_session when present", () => {
    const meta = formatChannelMeta({
      event: "cancel_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { reason: "Done" },
    });
    expect(meta.reason).toBe("Done");
  });

  it("omits reason for cancel_session when absent", () => {
    const meta = formatChannelMeta({
      event: "cancel_session",
      timestamp: "2026-04-05T10:00:00Z",
      payload: {},
    });
    expect(meta.reason).toBeUndefined();
  });

  it("includes ticketId and newOrder for priority_changed", () => {
    const meta = formatChannelMeta({
      event: "priority_changed",
      timestamp: "2026-04-05T10:00:00Z",
      payload: { ticketId: "T-050", newOrder: 3 },
    });
    expect(meta.ticketId).toBe("T-050");
    expect(meta.newOrder).toBe("3");
  });
});
