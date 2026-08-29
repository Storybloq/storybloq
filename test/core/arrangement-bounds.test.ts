import { describe, it, expect } from "vitest";
import {
  arrangementCoversTicket,
  arrangementCoversIssue,
  arrangementCoversWorkItem,
  arrangementCoversNodeItem,
  arrangementGateRiskWarnings,
  type TicketRefResolver,
  type IssueRefResolver,
  type WorkItemRef,
  type ArrangementGate,
} from "../../src/core/arrangement-bounds.js";
import type { Arrangement } from "../../src/models/arrangement.js";

function gate(name: string): ArrangementGate {
  return { name, ackRole: "pen" };
}

function baseArrangement(overrides: Partial<Arrangement> = {}): Arrangement {
  return {
    id: "a-0123456789abcdef",
    lifecycle: "active",
    bounds: ["T-474"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
      { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    ...overrides,
  } as Arrangement;
}

function fakeResolver(byRef: Record<string, { kind: "found"; item: { id: string } } | { kind: "missing" }>): TicketRefResolver {
  return {
    resolveTicketRef: (ref: string) => (byRef[ref] ?? { kind: "missing" }) as any,
  };
}

function fakeIssueResolver(byRef: Record<string, { kind: "found"; item: { id: string } } | { kind: "missing" }>): IssueRefResolver {
  return {
    resolveIssueRef: (ref: string) => (byRef[ref] ?? { kind: "missing" }) as any,
  };
}

const CANONICAL_TICKET = "t-0123456789abcdef";
const CANONICAL_ISSUE = "i-0123456789abcdef";

describe("arrangementCoversTicket", () => {
  it("matches a display-form ticket bound that resolves to the canonical id", () => {
    const arrangement = baseArrangement({ bounds: ["T-474"] });
    const resolver = fakeResolver({ "T-474": { kind: "found", item: { id: CANONICAL_TICKET } } });
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("matched");
  });

  it("matches a canonical ticket bound directly", () => {
    const arrangement = baseArrangement({ bounds: [CANONICAL_TICKET] });
    const resolver = fakeResolver({ [CANONICAL_TICKET]: { kind: "found", item: { id: CANONICAL_TICKET } } });
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("matched");
  });

  it("returns unmatched when no bound resolves to this ticket", () => {
    const arrangement = baseArrangement({ bounds: ["T-999"] });
    const resolver = fakeResolver({ "T-999": { kind: "found", item: { id: "t-fedcba9876543210" } } });
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("unmatched");
  });

  it("[B1] treats an issue-pattern bound as unmatched, never unresolved, even though it cannot resolve in a ticket index", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-1"] });
    // The resolver is never even consulted for an issue-pattern ref -- if it
    // were, this fake would throw, proving the classification happens first.
    const resolver: TicketRefResolver = {
      resolveTicketRef: () => {
        throw new Error("must not be called for an issue-pattern bound");
      },
    };
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("unmatched");
  });

  it("[B1] a canonical issue-pattern bound is also unmatched, not unresolved", () => {
    const arrangement = baseArrangement({ bounds: ["i-0123456789abcdef"] });
    const resolver: TicketRefResolver = {
      resolveTicketRef: () => {
        throw new Error("must not be called for an issue-pattern bound");
      },
    };
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("unmatched");
  });

  it("returns unresolved when a ticket-pattern bound cannot be resolved (e.g. a deleted ticket)", () => {
    const arrangement = baseArrangement({ bounds: ["T-999"] });
    const resolver = fakeResolver({ "T-999": { kind: "missing" } });
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("unresolved");
  });

  it("a matched bound short-circuits even if a LATER bound is unresolvable", () => {
    const arrangement = baseArrangement({ bounds: ["T-474", "T-999"] });
    const resolver = fakeResolver({
      "T-474": { kind: "found", item: { id: CANONICAL_TICKET } },
      "T-999": { kind: "missing" },
    });
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("matched");
  });

  it("mixed ticket and issue bounds: issue bound ignored, ticket bound drives the result", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-1", "T-474"] });
    const resolver = fakeResolver({ "T-474": { kind: "found", item: { id: CANONICAL_TICKET } } });
    expect(arrangementCoversTicket(arrangement, CANONICAL_TICKET, resolver)).toBe("matched");
  });
});

describe("[ISS-1049] arrangementCoversIssue", () => {
  it("matches a display-form issue bound that resolves to the canonical id", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-1"] });
    const resolver = fakeIssueResolver({ "ISS-1": { kind: "found", item: { id: CANONICAL_ISSUE } } });
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("matched");
  });

  it("matches a canonical issue bound directly", () => {
    const arrangement = baseArrangement({ bounds: [CANONICAL_ISSUE] });
    const resolver = fakeIssueResolver({ [CANONICAL_ISSUE]: { kind: "found", item: { id: CANONICAL_ISSUE } } });
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("matched");
  });

  it("returns unmatched when no bound resolves to this issue", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-999"] });
    const resolver = fakeIssueResolver({ "ISS-999": { kind: "found", item: { id: "i-fedcba9876543210" } } });
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("unmatched");
  });

  it("treats a ticket-pattern bound as unmatched, never unresolved -- symmetric to arrangementCoversTicket's issue-bound case", () => {
    const arrangement = baseArrangement({ bounds: ["T-474"] });
    const resolver: IssueRefResolver = {
      resolveIssueRef: () => {
        throw new Error("must not be called for a ticket-pattern bound");
      },
    };
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("unmatched");
  });

  it("a canonical ticket-pattern bound is also unmatched, not unresolved", () => {
    const arrangement = baseArrangement({ bounds: ["t-0123456789abcdef"] });
    const resolver: IssueRefResolver = {
      resolveIssueRef: () => {
        throw new Error("must not be called for a ticket-pattern bound");
      },
    };
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("unmatched");
  });

  it("returns unresolved when an issue-pattern bound cannot be resolved (e.g. a deleted issue)", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-999"] });
    const resolver = fakeIssueResolver({ "ISS-999": { kind: "missing" } });
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("unresolved");
  });

  it("a matched bound short-circuits even if a LATER bound is unresolvable", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-1", "ISS-999"] });
    const resolver = fakeIssueResolver({
      "ISS-1": { kind: "found", item: { id: CANONICAL_ISSUE } },
      "ISS-999": { kind: "missing" },
    });
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("matched");
  });

  it("mixed ticket and issue bounds: ticket bound ignored, issue bound drives the result", () => {
    const arrangement = baseArrangement({ bounds: ["T-474", "ISS-1"] });
    const resolver = fakeIssueResolver({ "ISS-1": { kind: "found", item: { id: CANONICAL_ISSUE } } });
    expect(arrangementCoversIssue(arrangement, CANONICAL_ISSUE, resolver)).toBe("matched");
  });
});

describe("[ISS-1049] arrangementCoversWorkItem", () => {
  function combinedResolver(
    ticket: Record<string, { kind: "found"; item: { id: string } } | { kind: "missing" }>,
    issue: Record<string, { kind: "found"; item: { id: string } } | { kind: "missing" }>,
  ): TicketRefResolver & IssueRefResolver {
    return { ...fakeResolver(ticket), ...fakeIssueResolver(issue) };
  }

  it("dispatches to arrangementCoversTicket for a ticket WorkItemRef", () => {
    const arrangement = baseArrangement({ bounds: ["T-474"] });
    const resolver = combinedResolver({ "T-474": { kind: "found", item: { id: CANONICAL_TICKET } } }, {});
    const item: WorkItemRef = { kind: "ticket", id: CANONICAL_TICKET };
    expect(arrangementCoversWorkItem(arrangement, item, resolver)).toBe("matched");
  });

  it("dispatches to arrangementCoversIssue for an issue WorkItemRef", () => {
    const arrangement = baseArrangement({ bounds: ["ISS-1"] });
    const resolver = combinedResolver({}, { "ISS-1": { kind: "found", item: { id: CANONICAL_ISSUE } } });
    const item: WorkItemRef = { kind: "issue", id: CANONICAL_ISSUE };
    expect(arrangementCoversWorkItem(arrangement, item, resolver)).toBe("matched");
  });

  it("an issue WorkItemRef against a ticket-only arrangement is unmatched, not matched or unresolved", () => {
    const arrangement = baseArrangement({ bounds: ["T-474"] });
    const resolver = combinedResolver({ "T-474": { kind: "found", item: { id: CANONICAL_TICKET } } }, {});
    const item: WorkItemRef = { kind: "issue", id: CANONICAL_ISSUE };
    expect(arrangementCoversWorkItem(arrangement, item, resolver)).toBe("unmatched");
  });
});

describe("[ISS-1077] arrangementCoversNodeItem", () => {
  it("matches when bounds contains the exact node-qualified canonical string", () => {
    const arrangement = baseArrangement({ bounds: [`engine:${CANONICAL_TICKET}`] });
    expect(arrangementCoversNodeItem(arrangement, "engine", CANONICAL_TICKET)).toBe(true);
  });

  it("does not match a different node's qualified bound with the same canonical id", () => {
    const arrangement = baseArrangement({ bounds: [`other-node:${CANONICAL_TICKET}`] });
    expect(arrangementCoversNodeItem(arrangement, "engine", CANONICAL_TICKET)).toBe(false);
  });

  it("does not match a plain local bound sharing the same canonical id string ([R2-FIX 4] qualified-only)", () => {
    const arrangement = baseArrangement({ bounds: [CANONICAL_TICKET] });
    expect(arrangementCoversNodeItem(arrangement, "engine", CANONICAL_TICKET)).toBe(false);
  });

  it("does not match when nothing in bounds is node-qualified at all", () => {
    const arrangement = baseArrangement({ bounds: ["T-474"] });
    expect(arrangementCoversNodeItem(arrangement, "engine", CANONICAL_TICKET)).toBe(false);
  });

  it("A4-2 residual fence: a hand-edited display-form bound against a team-mode node's canonical item fails closed (uncovered, not authorized)", () => {
    // Amendment A4 widened NodeQualifiedBoundRefSchema to accept display-form
    // node-qualified bounds (schema-valid), because non-team nodes have no
    // canonical id at all. The traced residual: a HAND-EDITED record could
    // store `engine:T-001` for an item whose team-mode node actually resolves
    // it to a canonical id. Coverage matching must still refuse it rather than
    // authorize it -- exact-string matching against the real resolved
    // canonical id already guarantees this, since the two strings differ.
    const arrangement = baseArrangement({ bounds: ["engine:T-001"] });
    expect(arrangementCoversNodeItem(arrangement, "engine", CANONICAL_TICKET)).toBe(false);
  });
});

describe("T-478: arrangementGateRiskWarnings (ISS-1050 interim)", () => {
  it("warns when plan-ack is configured alone, with no pre-commit-ack", () => {
    const warnings = arrangementGateRiskWarnings([gate("plan-ack")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/plan-ack/);
    expect(warnings[0]).toMatch(/pre-commit-ack/);
    expect(warnings[0]).toMatch(/ISS-1050/);
  });

  it("does not warn when both plan-ack and pre-commit-ack are configured", () => {
    expect(arrangementGateRiskWarnings([gate("plan-ack"), gate("pre-commit-ack")])).toEqual([]);
  });

  it("does not warn when only pre-commit-ack is configured", () => {
    expect(arrangementGateRiskWarnings([gate("pre-commit-ack")])).toEqual([]);
  });

  it("does not warn when there are no gates at all", () => {
    expect(arrangementGateRiskWarnings([])).toEqual([]);
  });
});
