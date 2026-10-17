import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fixturesDir, readJson } from "../helpers.js";
import { effectivePriority, effectiveWaitingOn, isWaiting } from "../../src/models/types.js";
import { TicketSchema } from "../../src/models/ticket.js";

describe("TicketSchema", () => {
  describe("valid tickets", () => {
    it("parses a complete ticket with all fields", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/T-001.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("T-001");
        expect(result.data.status).toBe("complete");
        expect(result.data.completedDate).toBe("2026-01-02");
        expect(result.data.parentTicket).toBeNull();
      }
    });

    it("parses a ticket with optional fields absent", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/T-002.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parentTicket).toBeUndefined();
        expect(result.data.createdBy).toBeUndefined();
      }
    });

    it("parses a suffixed ticket ID (T-005a)", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/T-005a.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("T-005a");
      }
    });

    it("parses a chore ticket type", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/T-005a.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("chore");
      }
    });

    it("parses a ticket with parentTicket set", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/T-004.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parentTicket).toBe("T-003");
      }
    });

    it("parses all valid fixture tickets", () => {
      const ticketFiles = ["T-001.json", "T-002.json", "T-003.json", "T-004.json", "T-005a.json"];
      for (const file of ticketFiles) {
        const data = readJson(resolve(fixturesDir, `valid/basic/tickets/${file}`));
        const result = TicketSchema.safeParse(data);
        expect(result.success, `Failed to parse ${file}`).toBe(true);
      }
    });
  });

  describe("invalid tickets", () => {
    it("rejects a ticket with missing id", () => {
      const data = readJson(resolve(fixturesDir, "invalid/missing-id-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with invalid status enum", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-status-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with invalid id format", () => {
      const data = {
        id: "TICKET-001", title: "Bad ID", description: "", type: "task",
        status: "open", phase: null, order: 10, createdDate: "2026-01-01",
        completedDate: null, blockedBy: [],
      };
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with impossible calendar date", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-date-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with invalid blockedBy ID format", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-blockedby-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });
  });

  describe("round-trip unknown key preservation", () => {
    it("preserves unknown extra keys through parse and serialize", () => {
      const data = readJson(resolve(fixturesDir, "valid/extra-fields-ticket.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.customField).toBe("should be preserved");
        expect(result.data.anotherExtra).toBe(42);
        expect(result.data.nestedExtra).toEqual({ key: "value" });

        const serialized = JSON.parse(JSON.stringify(result.data));
        const reparsed = TicketSchema.safeParse(serialized);
        expect(reparsed.success).toBe(true);
        if (reparsed.success) {
          expect(reparsed.data.customField).toBe("should be preserved");
          expect(reparsed.data.anotherExtra).toBe(42);
          expect(reparsed.data.nestedExtra).toEqual({ key: "value" });
        }
      }
    });
  });

  describe("crossNodeBlockedBy (T-337)", () => {
    const validTicket = {
      id: "T-100", title: "Test", description: "", type: "task",
      status: "open", phase: null, order: 10, createdDate: "2026-01-01",
      completedDate: null, blockedBy: [],
    };

    it("accepts ticket with crossNodeBlockedBy field", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["engine:T-061", "cloud:ISS-005"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.crossNodeBlockedBy).toEqual(["engine:T-061", "cloud:ISS-005"]);
      }
    });

    it("accepts ticket without crossNodeBlockedBy (optional)", () => {
      const result = TicketSchema.safeParse(validTicket);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.crossNodeBlockedBy).toBeUndefined();
      }
    });

    it("rejects invalid cross-node ref format (missing node prefix)", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["T-061"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects uppercase node name in ref", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["Engine:T-061"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("accepts suffixed ticket ID in ref", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["engine:T-012a"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts issue ID in ref", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["cloud:ISS-042"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("attribution fields (updatedAt / updatedDate)", () => {
    const validTicket = {
      id: "T-200", title: "Test", description: "", type: "task",
      status: "open", phase: null, order: 10, createdDate: "2026-01-01",
      completedDate: null, blockedBy: [],
    };

    it("parses and round-trips updatedDate + updatedAt", () => {
      const data = { ...validTicket, updatedDate: "2026-05-20", updatedAt: "2026-05-20T10:00:00Z" };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.updatedDate).toBe("2026-05-20");
        expect(result.data.updatedAt).toBe("2026-05-20T10:00:00Z");
        const reparsed = TicketSchema.safeParse(JSON.parse(JSON.stringify(result.data)));
        expect(reparsed.success).toBe(true);
      }
    });

    it("accepts a ticket without updatedAt/updatedDate (optional)", () => {
      const result = TicketSchema.safeParse(validTicket);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.updatedAt).toBeUndefined();
        expect(result.data.updatedDate).toBeUndefined();
      }
    });

    it("accepts a loose (non-ISO) updatedAt string rather than rejecting the file", () => {
      // updatedAt is intentionally permissive; the merge layer treats unparseable values as
      // ambiguous instead of failing to load. This guards against rejecting legacy data.
      const data = { ...validTicket, updatedAt: "not-a-timestamp" };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });
});

// T-481 B1: priority and waitingOn load whatever is stored, including values
// outside p0..p3 and owner/external/none, so repair can reach and unset them.
describe("T-481 B1: TicketSchema loads priority and waitingOn values as stored", () => {
  const base = readJson(resolve(fixturesDir, "valid/basic/tickets/T-002.json")) as Record<string, unknown>;
  it("absent fields load", () => {
    const r = TicketSchema.safeParse(base);
    expect(r.success).toBe(true);
  });
  for (const value of [{ priority: "p0" }, { priority: "p1" }, { priority: "p2" }, { priority: "p3" },
    { waitingOn: "owner" }, { waitingOn: "external" }, { waitingOn: "none" },
    { priority: "high" }, { waitingOn: "maybe" }, { priority: "high", waitingOn: "maybe" }]) {
    it(`loads ${JSON.stringify(value)} unchanged`, () => {
      const r = TicketSchema.safeParse({ ...base, ...value });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toMatchObject(value);
    });
  }
});

// T-481 T1: readers go through the views; an unrecognised value reads as the
// default and never throws.
describe("T-481 T1: effectivePriority and effectiveWaitingOn on a loaded ticket", () => {
  const base = readJson(resolve(fixturesDir, "valid/basic/tickets/T-002.json")) as Record<string, unknown>;
  const load = (extra: Record<string, unknown>) => TicketSchema.parse({ ...base, ...extra });
  it("absent reads as p2 and none", () => {
    expect(effectivePriority(load({}))).toBe("p2");
    expect(effectiveWaitingOn(load({}))).toBe("none");
    expect(isWaiting(load({}))).toBe(false);
  });
  it("recognised values read as stored", () => {
    for (const p of ["p0", "p1", "p2", "p3"]) expect(effectivePriority(load({ priority: p }))).toBe(p);
    expect(effectiveWaitingOn(load({ waitingOn: "owner" }))).toBe("owner");
    expect(effectiveWaitingOn(load({ waitingOn: "external" }))).toBe("external");
    expect(isWaiting(load({ waitingOn: "owner" }))).toBe(true);
    expect(isWaiting(load({ waitingOn: "external" }))).toBe(true);
    expect(isWaiting(load({ waitingOn: "none" }))).toBe(false);
  });
  it('"high" and "maybe" read as p2 and none', () => {
    expect(effectivePriority(load({ priority: "high" }))).toBe("p2");
    expect(effectiveWaitingOn(load({ waitingOn: "maybe" }))).toBe("none");
    expect(isWaiting(load({ waitingOn: "maybe" }))).toBe(false);
    expect(effectivePriority(load({ priority: 3 }))).toBe("p2");
  });
});
