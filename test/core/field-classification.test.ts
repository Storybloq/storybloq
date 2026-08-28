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
