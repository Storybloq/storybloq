import { describe, it, expect } from "vitest";
import { arrangementCoversTicket, arrangementGateRiskWarnings, type TicketRefResolver, type ArrangementGate } from "../../src/core/arrangement-bounds.js";
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

const CANONICAL_TICKET = "t-0123456789abcdef";

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
