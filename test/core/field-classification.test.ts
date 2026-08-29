import { describe, it, expect } from "vitest";
import { getMergeRules, getCoupledGroups } from "../../src/core/field-classification.js";

describe("T-385: field classification", () => {
  it("ticket rules cover all core fields", () => {
    const rules = getMergeRules("ticket");
    expect(rules.id).toBeDefined();
    expect(rules.title).toBeDefined();
    expect(rules.status).toBeDefined();
    expect(rules.blockedBy).toBeDefined();
    expect(rules.phase).toBeDefined();
    expect(rules.order).toBeDefined();
    expect(rules.parentTicket).toBeDefined();
  });

  it("issue rules cover all core fields", () => {
    const rules = getMergeRules("issue");
    expect(rules.id).toBeDefined();
    expect(rules.title).toBeDefined();
    expect(rules.status).toBeDefined();
    expect(rules.severity).toBeDefined();
    expect(rules.relatedTickets).toBeDefined();
    expect(rules.components).toBeDefined();
    expect(rules.sourceRefs?.kind).toBe("commutative");
    expect(rules.dedupeKey?.kind).toBe("identity");
  });

  it("T-475: earmark is hard-conflict for both ticket and issue (not a coupled group -- nothing else to couple it with)", () => {
    expect(getMergeRules("ticket").earmark).toEqual({ kind: "hard-conflict" });
    expect(getMergeRules("issue").earmark).toEqual({ kind: "hard-conflict" });
  });

  it("ISS-1032 (Amendment A5): resolutionEpoch is a deliberately-classified hard-conflict on issue, not a silent default", () => {
    expect(getMergeRules("issue").resolutionEpoch).toEqual({ kind: "hard-conflict" });
    // Ticket carries no resolutionEpoch concept -- confirming absence keeps
    // this test honest about which entity the rule actually applies to.
    expect(getMergeRules("ticket").resolutionEpoch).toBeUndefined();
  });

  it("coupled groups are symmetric", () => {
    const groups = getCoupledGroups("ticket");
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.members.length).toBeGreaterThanOrEqual(2);
      const rules = getMergeRules("ticket");
      for (const member of g.members) {
        const rule = rules[member];
        expect(rule).toBeDefined();
        expect(rule!.kind).toBe("coupled");
        expect((rule as { group: string }).group).toBe(g.group);
      }
    }
  });

  it("getMergeRules returns empty for unknown entity type", () => {
    const rules = getMergeRules("unknown" as any);
    expect(Object.keys(rules).length).toBe(0);
  });
});

describe("T-478: arrangement field classification", () => {
  it("classifies identity, monotonic, commutative, and hard-conflict fields per the ratified plan table", () => {
    const rules = getMergeRules("arrangement");
    expect(rules.id).toEqual({ kind: "identity" });
    expect(rules.createdDate).toEqual({ kind: "identity" });
    expect(rules.createdBy).toEqual({ kind: "identity" });
    expect(rules.updatedAt).toEqual({ kind: "monotonic", compare: "max" });
    expect(rules.citesRulings).toEqual({ kind: "commutative" });
    expect(rules.lifecycle).toEqual({ kind: "hard-conflict" });
    expect(rules.bounds).toEqual({ kind: "hard-conflict" });
    expect(rules.parties).toEqual({ kind: "hard-conflict" });
    expect(rules.gates).toEqual({ kind: "hard-conflict" });
    expect(rules.treeProtocol).toEqual({ kind: "hard-conflict" });
    expect(rules.reviewBounds).toEqual({ kind: "hard-conflict" });
    expect(rules.unreachability).toEqual({ kind: "hard-conflict" });
  });

  it("has no coupled groups -- correct, not a degenerate answer (no field pairs analogous to ticket's attribution/ticket-claim groups)", () => {
    expect(getCoupledGroups("arrangement")).toEqual([]);
  });
});
