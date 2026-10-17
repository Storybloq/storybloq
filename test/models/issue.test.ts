import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fixturesDir, readJson } from "../helpers.js";
import { effectivePriority, effectiveWaitingOn, isWaiting } from "../../src/models/types.js";
import {
  IssueSchema,
  IssueSourceRefInputSchema,
  IssueSourceRefSchema,
} from "../../src/models/issue.js";

describe("IssueSchema", () => {
  describe("valid issues", () => {
    it("parses a resolved issue with all fields", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-001.json"));
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("ISS-001");
        expect(result.data.status).toBe("resolved");
        expect(result.data.resolution).toBe("Updated engines field to require Node 20+.");
        expect(result.data.resolvedDate).toBe("2026-01-03");
      }
    });

    it("parses an open issue with optional order and phase", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-002.json"));
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order).toBe(10);
        expect(result.data.phase).toBe("alpha");
        expect(result.data.resolution).toBeNull();
        expect(result.data.resolvedDate).toBeNull();
      }
    });

    it("parses an issue with optional fields absent", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-001.json"));
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order).toBeUndefined();
        expect(result.data.phase).toBeUndefined();
      }
    });

    it("parses critical severity", () => {
      const data = {
        id: "ISS-099", title: "Critical issue", status: "open", severity: "critical",
        components: ["core"], impact: "System down.", resolution: null,
        location: ["main.ts:1"], discoveredDate: "2026-01-01", resolvedDate: null,
        relatedTickets: [],
      };
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.severity).toBe("critical");
      }
    });

    it("parses all valid fixture issues", () => {
      for (const file of ["ISS-001.json", "ISS-002.json"]) {
        const data = readJson(resolve(fixturesDir, `valid/basic/issues/${file}`));
        expect(IssueSchema.safeParse(data).success, `Failed to parse ${file}`).toBe(true);
      }
    });
  });

  describe("invalid issues", () => {
    it("rejects an issue with invalid severity", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-severity-issue.json"));
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });

    it("rejects an issue with invalid id format", () => {
      const data = {
        id: "ISSUE-001", title: "Bad ID", status: "open", severity: "low",
        components: [], impact: "None.", resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
      };
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });

    it("rejects an issue with missing required field", () => {
      const data = {
        id: "ISS-100", title: "Missing impact", status: "open", severity: "low",
        components: [], resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
      };
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });

    it("rejects an issue with invalid relatedTickets format", () => {
      const data = {
        id: "ISS-101", title: "Bad related", status: "open", severity: "low",
        components: [], impact: "Bad ref.", resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: ["not-a-ticket-id"],
      };
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });
  });

  describe("round-trip unknown key preservation", () => {
    it("preserves unknown extra keys through parse and serialize", () => {
      const data = {
        id: "ISS-050", title: "Issue with extras", status: "open", severity: "low",
        components: ["test"], impact: "None.", resolution: null, location: ["file.ts:1"],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
        extraField: "preserved", extraNumber: 99,
      };
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.extraField).toBe("preserved");
        expect(result.data.extraNumber).toBe(99);

        const serialized = JSON.parse(JSON.stringify(result.data));
        const reparsed = IssueSchema.safeParse(serialized);
        expect(reparsed.success).toBe(true);
        if (reparsed.success) {
          expect(reparsed.data.extraField).toBe("preserved");
        }
      }
    });
  });

  describe("source references", () => {
    const hash = "a".repeat(64);

    it("accepts durable revision and hash provenance", () => {
      const result = IssueSourceRefSchema.safeParse({
        path: "src/example.ts",
        startLine: 4,
        endLine: 6,
        revision: "abcdef12",
        contentHash: hash,
        reviewId: "review-1",
      });
      expect(result.success).toBe(true);
    });

    it("allows write input without a hash so the handler can capture it", () => {
      expect(IssueSourceRefInputSchema.safeParse({
        path: "src/example.ts",
        startLine: 4,
      }).success).toBe(true);
    });

    it("keeps write input strict while persisted refs preserve additive fields", () => {
      const candidate = {
        path: "src/example.ts",
        startLine: 4,
        contentHash: hash,
        futureEvidence: { provider: "review-v2" },
      };

      expect(IssueSourceRefInputSchema.safeParse(candidate).success).toBe(false);
      const persisted = IssueSourceRefSchema.safeParse(candidate);
      expect(persisted.success).toBe(true);
      if (persisted.success) {
        expect(persisted.data.futureEvidence).toEqual({ provider: "review-v2" });
      }
    });

    it("requires durable persisted provenance", () => {
      expect(IssueSourceRefSchema.safeParse({
        path: "src/example.ts",
        startLine: 4,
      }).success).toBe(false);
    });

    it.each([
      "/tmp/example.ts",
      "../example.ts",
      "src/../example.ts",
      "src\\example.ts",
      "src/example.ts:4",
    ])("rejects unsafe source path %s", (path) => {
      expect(IssueSourceRefInputSchema.safeParse({ path, startLine: 1 }).success).toBe(false);
    });

    it("rejects reversed line ranges and malformed hashes", () => {
      expect(IssueSourceRefInputSchema.safeParse({
        path: "src/example.ts",
        startLine: 5,
        endLine: 4,
      }).success).toBe(false);
      expect(IssueSourceRefSchema.safeParse({
        path: "src/example.ts",
        startLine: 1,
        contentHash: "not-a-hash",
      }).success).toBe(false);
    });

    it("rejects control characters in provenance identifiers", () => {
      expect(IssueSourceRefInputSchema.safeParse({
        path: "src/example.ts",
        startLine: 1,
        reviewId: "review\u001b[2J",
      }).success).toBe(false);
    });
  });
});

// T-481 B1: priority and waitingOn load whatever is stored, including values
// outside p0..p3 and owner/external/none, so repair can reach and unset them.
describe("T-481 B1: IssueSchema loads priority and waitingOn values as stored", () => {
  const base = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-002.json")) as Record<string, unknown>;
  it("absent fields load", () => {
    const r = IssueSchema.safeParse(base);
    expect(r.success).toBe(true);
  });
  for (const value of [{ priority: "p0" }, { priority: "p1" }, { priority: "p2" }, { priority: "p3" },
    { waitingOn: "owner" }, { waitingOn: "external" }, { waitingOn: "none" },
    { priority: "high" }, { waitingOn: "maybe" }, { priority: "high", waitingOn: "maybe" }]) {
    it(`loads ${JSON.stringify(value)} unchanged`, () => {
      const r = IssueSchema.safeParse({ ...base, ...value });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toMatchObject(value);
    });
  }
});

// T-481 T1: readers go through the views; an unrecognised value reads as the
// default and never throws.
describe("T-481 T1: effectivePriority and effectiveWaitingOn on a loaded issue", () => {
  const base = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-002.json")) as Record<string, unknown>;
  const load = (extra: Record<string, unknown>) => IssueSchema.parse({ ...base, ...extra });
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
