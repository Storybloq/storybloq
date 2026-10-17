/**
 * T-481 B2: how the merge driver treats updatedDate, priority and waitingOn.
 * Characterisation of the existing attribution-group policy
 * (field-classification.ts: lastModifiedBy + updatedAt + updatedDate travel
 * together, latest updatedAt wins, ambiguous is a conflict). T-481 starts
 * stamping updatedDate; it does not change this policy.
 */
import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/core/merge-driver.js";

function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-001", title: "Test", description: "", type: "task",
    status: "open", phase: "p1", order: 10, createdDate: "2020-01-01",
    blockedBy: [], parentTicket: null, completedDate: null,
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ISS-001", title: "Bug", status: "open", severity: "high",
    components: [], impact: "Breaks things", resolution: null,
    location: [], discoveredDate: "2020-01-01", resolvedDate: null,
    relatedTickets: [],
    ...overrides,
  };
}

const kinds = [
  { kind: "ticket" as const, make: ticket, editA: { title: "Ours" }, editB: { description: "theirs" } },
  { kind: "issue" as const, make: issue, editA: { title: "Ours" }, editB: { impact: "theirs" } },
];

for (const k of kinds) {
  describe(`T-481 B2 (${k.kind}): updatedDate in the attribution group`, () => {
    it("case 1: both sides edited on the same day with the same modifier merge cleanly", () => {
      const base = k.make({ updatedDate: "2020-01-01" });
      const ours = k.make({ ...k.editA, updatedDate: "2026-06-01" });
      const theirs = k.make({ ...k.editB, updatedDate: "2026-06-01" });
      const result = threeWayMerge(base, ours, theirs, k.kind);
      expect(result.clean).toBe(true);
      expect(result.merged.updatedDate).toBe("2026-06-01");
      expect(result.merged).toMatchObject({ ...k.editA, ...k.editB });
    });

    it("case 2: same day, distinct modifiers: an attribution conflict keeps ours whole; content still merges", () => {
      const base = k.make({ updatedDate: "2020-01-01", lastModifiedBy: "alice@test.com" });
      const ours = k.make({ ...k.editA, updatedDate: "2026-06-01", lastModifiedBy: "bob@test.com" });
      const theirs = k.make({ ...k.editB, updatedDate: "2026-06-01", lastModifiedBy: "carol@test.com" });
      const result = threeWayMerge(base, ours, theirs, k.kind);
      expect(result.clean).toBe(false);
      expect(result.conflicts.every((c) => c.group === "attribution")).toBe(true);
      expect(result.merged.lastModifiedBy).toBe("bob@test.com");
      expect(result.merged.updatedDate).toBe("2026-06-01");
      expect(result.merged).toMatchObject({ ...k.editA, ...k.editB });
    });

    it("case 3: one side with a stale updatedAt, the other with only a newer updatedDate (outcome recorded)", () => {
      const base = k.make({ updatedDate: "2020-01-01", lastModifiedBy: "alice@test.com" });
      const ours = k.make({ ...k.editA, updatedAt: "2026-05-20T10:00:00Z", lastModifiedBy: "bob@test.com" });
      const theirs = k.make({ ...k.editB, updatedDate: "2026-06-01", lastModifiedBy: "carol@test.com" });
      const result = threeWayMerge(base, ours, theirs, k.kind);
      expect({
        clean: result.clean,
        lastModifiedBy: result.merged.lastModifiedBy,
        updatedAt: result.merged.updatedAt,
        updatedDate: result.merged.updatedDate,
      }).toEqual(CASE3);
    });

    it("case 4: date-only records on different days: the later day wins the whole group", () => {
      const base = k.make({ updatedDate: "2020-01-01", lastModifiedBy: "alice@test.com" });
      const ours = k.make({ ...k.editA, updatedDate: "2026-06-01", lastModifiedBy: "bob@test.com" });
      const theirs = k.make({ ...k.editB, updatedDate: "2026-06-03", lastModifiedBy: "carol@test.com" });
      const result = threeWayMerge(base, ours, theirs, k.kind);
      expect(result.clean).toBe(true);
      expect(result.merged.updatedDate).toBe("2026-06-03");
      expect(result.merged.lastModifiedBy).toBe("carol@test.com");
    });

    it("divergent priority is a field conflict; a one-sided priority or waitingOn change wins", () => {
      const base = k.make({ priority: "p2" });
      const split = threeWayMerge(base, k.make({ priority: "p1" }), k.make({ priority: "p3" }), k.kind);
      expect(split.clean).toBe(false);
      expect(split.conflicts.some((c) => c.field === "priority")).toBe(true);
      const one = threeWayMerge(base, k.make({ priority: "p0" }), k.make({ priority: "p2", waitingOn: "owner" }), k.kind);
      expect(one.clean).toBe(true);
      expect(one.merged.priority).toBe("p0");
      expect(one.merged.waitingOn).toBe("owner");
    });
  });
}

// Recorded from the first base run at 440397eb: recency reads `updatedAt ??
// updatedDate`, so the day-only 2026-06-01 outranks the 2026-05-20 instant and
// theirs wins the whole group cleanly; ours' updatedAt goes with its group.
const CASE3 = { clean: true, lastModifiedBy: "carol@test.com", updatedAt: undefined, updatedDate: "2026-06-01" } as Record<string, unknown>;
