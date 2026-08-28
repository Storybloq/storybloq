import { describe, it, expect } from "vitest";
import { EarmarkSchema, OwnerTaskLikeSchema } from "../../src/models/types.js";
import { TicketSchema } from "../../src/models/ticket.js";
import { IssueSchema } from "../../src/models/issue.js";

const ARRANGEMENT_ID = "a-0123456789abcdef";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SINCE = "2026-08-28T00:00:00.000Z";
const RESERVED_BY = { client: "claude" as const, id: "task-1" };

function reserved(overrides: Record<string, unknown> = {}) {
  return {
    stage: "reserved",
    reservedBy: RESERVED_BY,
    arrangementId: ARRANGEMENT_ID,
    since: SINCE,
    holderRole: "worker",
    holderSession: null,
    ...overrides,
  };
}

function assigned(overrides: Record<string, unknown> = {}) {
  return {
    stage: "assigned",
    reservedBy: RESERVED_BY,
    arrangementId: ARRANGEMENT_ID,
    since: SINCE,
    holderRole: "worker",
    holderSession: SESSION_ID,
    ...overrides,
  };
}

describe("OwnerTaskLikeSchema", () => {
  it("accepts a well-formed claude/codex actor", () => {
    expect(OwnerTaskLikeSchema.safeParse({ client: "claude", id: "task-1" }).success).toBe(true);
    expect(OwnerTaskLikeSchema.safeParse({ client: "codex", id: "task-2" }).success).toBe(true);
  });

  it("rejects an unknown client", () => {
    expect(OwnerTaskLikeSchema.safeParse({ client: "cursor", id: "task-1" }).success).toBe(false);
  });

  it("rejects an id that fails CLIENT_TASK_ID_PATTERN", () => {
    expect(OwnerTaskLikeSchema.safeParse({ client: "claude", id: "" }).success).toBe(false);
    expect(OwnerTaskLikeSchema.safeParse({ client: "claude", id: "has spaces" }).success).toBe(false);
  });
});

describe("EarmarkSchema", () => {
  it("parses a well-formed reserved earmark", () => {
    expect(EarmarkSchema.safeParse(reserved()).success).toBe(true);
  });

  it("parses a well-formed assigned earmark", () => {
    expect(EarmarkSchema.safeParse(assigned()).success).toBe(true);
  });

  it("rejects a reserved earmark with a non-null holderSession (unrepresentable invalid state)", () => {
    const result = EarmarkSchema.safeParse(reserved({ holderSession: SESSION_ID }));
    expect(result.success).toBe(false);
  });

  it("rejects an assigned earmark with a null holderSession (unrepresentable invalid state)", () => {
    const result = EarmarkSchema.safeParse(assigned({ holderSession: null }));
    expect(result.success).toBe(false);
  });

  it("rejects an assigned earmark whose holderSession is not a UUID", () => {
    const result = EarmarkSchema.safeParse(assigned({ holderSession: "not-a-uuid" }));
    expect(result.success).toBe(false);
  });

  it("rejects a missing arrangementId (required, not optional)", () => {
    const { arrangementId: _drop, ...withoutArrangement } = reserved();
    expect(EarmarkSchema.safeParse(withoutArrangement).success).toBe(false);
  });

  it("rejects a malformed arrangementId", () => {
    expect(EarmarkSchema.safeParse(reserved({ arrangementId: "not-an-arrangement" })).success).toBe(false);
  });

  it("rejects a missing since", () => {
    const { since: _drop, ...withoutSince } = reserved();
    expect(EarmarkSchema.safeParse(withoutSince).success).toBe(false);
  });

  it("rejects a since that is not a parseable ISO datetime", () => {
    expect(EarmarkSchema.safeParse(reserved({ since: "not-a-date" })).success).toBe(false);
    expect(EarmarkSchema.safeParse(reserved({ since: "2026-08-28" })).success).toBe(false);
  });

  it("rejects an unknown stage", () => {
    expect(EarmarkSchema.safeParse(reserved({ stage: "pending" })).success).toBe(false);
  });

  it("rejects an unknown holderRole", () => {
    expect(EarmarkSchema.safeParse(reserved({ holderRole: "admin" })).success).toBe(false);
  });

  it("rejects a bare-string reservedBy (structured actor required, round-3 fix)", () => {
    expect(EarmarkSchema.safeParse(reserved({ reservedBy: "some-session-id" })).success).toBe(false);
  });
});

describe("Ticket/Issue earmark field", () => {
  const baseTicket = {
    id: "t-0123456789abcdef",
    title: "t",
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order: 0,
    createdDate: "2026-08-28",
    completedDate: null,
    blockedBy: [],
  };

  const baseIssue = {
    id: "i-0123456789abcdef",
    title: "i",
    status: "open",
    severity: "low",
    components: [],
    impact: "",
    resolution: null,
    location: [],
    discoveredDate: "2026-08-28",
    resolvedDate: null,
    relatedTickets: [],
  };

  it("TicketSchema accepts an absent earmark", () => {
    expect(TicketSchema.safeParse(baseTicket).success).toBe(true);
  });

  it("TicketSchema accepts a null earmark", () => {
    expect(TicketSchema.safeParse({ ...baseTicket, earmark: null }).success).toBe(true);
  });

  it("TicketSchema accepts a well-formed earmark and does not touch claimedBySession/claim/assignedTo", () => {
    const result = TicketSchema.safeParse({ ...baseTicket, earmark: assigned() });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claimedBySession).toBeUndefined();
      expect(result.data.claim).toBeUndefined();
      expect(result.data.assignedTo).toBeUndefined();
    }
  });

  it("TicketSchema rejects a malformed earmark", () => {
    expect(TicketSchema.safeParse({ ...baseTicket, earmark: reserved({ arrangementId: "bad" }) }).success).toBe(false);
  });

  it("IssueSchema accepts an absent earmark", () => {
    expect(IssueSchema.safeParse(baseIssue).success).toBe(true);
  });

  it("IssueSchema accepts a well-formed earmark", () => {
    expect(IssueSchema.safeParse({ ...baseIssue, earmark: reserved() }).success).toBe(true);
  });

  it("IssueSchema rejects a malformed earmark", () => {
    expect(IssueSchema.safeParse({ ...baseIssue, earmark: assigned({ holderSession: "not-a-uuid" }) }).success).toBe(false);
  });
});
