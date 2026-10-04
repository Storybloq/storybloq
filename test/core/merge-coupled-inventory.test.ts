import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { getCoupledGroups, type CatalogEntryType, type EntityType } from "../../src/core/field-classification.js";

// T-486 U2-1 fixup: the driver's per-member base fallback can build a group
// body that no side holds whole. Every coupled group is either keep-ours or
// resolves through recency; these tests pin which, and probe the recency
// groups' ambiguous branches.

const TYPES: (EntityType | CatalogEntryType)[] = ["ticket", "issue", "note", "lesson", "arrangement", "ruling", "capability", "term"];

function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-001", title: "Test", description: "", type: "task",
    status: "open", phase: "p1", order: 10, createdDate: "2026-01-01",
    blockedBy: [], parentTicket: null, completedDate: null,
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ISS-001", title: "Bug", status: "open", severity: "high",
    components: [], impact: "Breaks things", resolution: null,
    location: [], discoveredDate: "2026-01-01", resolvedDate: null,
    relatedTickets: [],
    ...overrides,
  };
}

const ATTRIBUTION = ["lastModifiedBy", "updatedAt", "updatedDate"];

describe("T-486 coupled groups: the per-member base fallback is closed as a class", () => {
  it("every coupled group on every type is keep-ours or resolves through recency", () => {
    for (const type of TYPES) {
      for (const g of getCoupledGroups(type)) {
        const ok = g.onDivergence === "keep-ours" || g.latestWinsField !== undefined;
        expect(ok, `${type} coupled group "${g.group}" would reach the per-member base fallback: choose keep-ours or latestWinsField`).toBe(true);
      }
    }
  });

  describe.each([["ticket", ticket], ["issue", issue]] as const)("%s attribution, a tie on recency", (type, make) => {
    const keepsOursWhole = (r: ReturnType<typeof threeWayMerge>, ours: Record<string, unknown>, theirs: Record<string, unknown>) => {
      expect(r.clean).toBe(false);
      for (const m of ATTRIBUTION) {
        expect(Object.hasOwn(r.merged, m), m).toBe(Object.hasOwn(ours, m));
        if (Object.hasOwn(ours, m)) expect(r.merged[m], m).toStrictEqual(ours[m]);
      }
      const entries = r.conflicts.filter((c) => c.group === "attribution");
      expect(entries.map((c) => c.field).sort()).toEqual([...ATTRIBUTION].sort());
      for (const c of entries) expect(c.theirs, c.field).toStrictEqual(theirs[String(c.field)]);
    };

    it("a base holding every member keeps ours whole in the body and theirs whole in the entries", () => {
      const base = make({ lastModifiedBy: "x", updatedAt: "2026-01-01T00:00:00Z", updatedDate: "2026-01-01" });
      const ours = make({ lastModifiedBy: "a", updatedAt: "2026-02-01T00:00:00Z", updatedDate: "2026-02-01" });
      const theirs = make({ lastModifiedBy: "b", updatedAt: "2026-02-01T00:00:00Z", updatedDate: "2026-02-01" });
      keepsOursWhole(threeWayMerge(base, ours, theirs, type), ours, theirs);
    });

    it("a base lacking a member never pairs base's time with a side's modifier", () => {
      // Before T-486 the body took base's updatedAt and updatedDate with ours'
      // lastModifiedBy: an attribution no side holds whole.
      const base = make({ updatedAt: "2026-01-01T00:00:00Z", updatedDate: "2026-01-01" });
      const ours = make({ lastModifiedBy: "a", updatedAt: "2026-02-01T00:00:00Z", updatedDate: "2026-02-01" });
      const theirs = make({ lastModifiedBy: "b", updatedAt: "2026-02-01T00:00:00Z", updatedDate: "2026-02-01" });
      keepsOursWhole(threeWayMerge(base, ours, theirs, type), ours, theirs);
    });

    it("a member absent on every side stays absent, never an undefined own key", () => {
      const base = make({ lastModifiedBy: "x", updatedAt: "2026-01-01T00:00:00Z" });
      const ours = make({ lastModifiedBy: "a", updatedAt: "2026-02-01T00:00:00Z" });
      const theirs = make({ lastModifiedBy: "b", updatedAt: "2026-02-01T00:00:00Z" });
      const r = threeWayMerge(base, ours, theirs, type);
      expect(r.clean).toBe(false);
      expect("updatedDate" in r.merged).toBe(false);
      // The serialised body has no such key (its conflict entry may still name it).
      expect(Object.keys(JSON.parse(JSON.stringify(r.merged)))).not.toContain("updatedDate");
    });
  });

  it("ticket-claim pin (ISS-786 doctrine): a tie releases the whole group, a deliberate outcome, never a mix of claims", () => {
    const base = ticket({ claim: { user: "x@test.com", branch: "feat/x", since: "2026-05-20T10:00:00Z" }, claimedBySession: "sess-0" });
    const ours = ticket({ claim: { user: "a@test.com", branch: "feat/a", since: "2026-05-25T10:00:00Z" }, claimedBySession: "sess-1" });
    const theirs = ticket({ claim: { user: "b@test.com", branch: "feat/b", since: "2026-05-25T10:00:00Z" }, claimedBySession: "sess-2" });
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect("claim" in r.merged).toBe(false);
    expect("claimedBySession" in r.merged).toBe(false);
  });
});
