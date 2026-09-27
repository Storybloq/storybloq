/**
 * T-537 S1: the owner checkpoint model, digest and predicates. RED at
 * 09e7dade: `src/core/owner-checkpoint.ts` and
 * `scripts/owner-checkpoint-vectors.ts` do not exist there, and
 * `TicketSchema` drops nothing but types neither field.
 *
 * The expectations below are written out by hand; the vectors file is the
 * CLI's own output and the drift test only proves it is current.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_CHECKPOINT_COUNTER,
  checkpointApproved,
  checkpointDigest,
  checkpointProjection,
  checkpointReleases,
  checkpointState,
  hasOwnerCheckpoint,
  isWellFormedText,
  needsReassessment,
  parseCheckpointEvidence,
  parseOwnerCheckpoint,
  pendingCheckpointBlockers,
  reassessCheckpoints,
} from "../../src/core/owner-checkpoint.js";
import { canonicalJson } from "../../src/bus/canonical.js";
import { TicketSchema, type Ticket } from "../../src/models/ticket.js";
import { SCENARIO_SPECS, VECTORS_OUT, serializeVectors } from "../../scripts/owner-checkpoint-vectors.js";
import { makeState } from "./test-factories.js";

const scenario = (name: string) => {
  const spec = SCENARIO_SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`no scenario ${name}`);
  const tickets = spec.tickets.map((t) => TicketSchema.parse(t)) as Ticket[];
  const state = makeState({ tickets });
  const byId = (id: string) => tickets.find((t) => t.id === id)!;
  return { state, byId };
};

describe("owner checkpoint vectors", () => {
  it("the checked-in file equals the CLI's output", () => {
    expect(readFileSync(VECTORS_OUT, "utf-8")).toBe(serializeVectors());
  });
});

describe("checkpoint digest", () => {
  it("serialises the projection with sorted keys and omits a missing or null text", () => {
    expect(canonicalJson(checkpointProjection({ kind: "decision", question: "Ship?", evidenceRefs: [] }))).toBe('{"evidenceRefs":[],"kind":"decision","question":"Ship?"}');
    expect(canonicalJson(checkpointProjection({ kind: "acceptance", question: null, criteria: "c", evidenceRefs: ["b", "a"] }))).toBe('{"criteria":"c","evidenceRefs":["b","a"],"kind":"acceptance"}');
  });

  it("normalises to NFC: decomposed and precomposed text share a digest", () => {
    expect(checkpointDigest({ kind: "decision", question: "Cafe\u0301", evidenceRefs: ["re\u0301sume\u0301"] }))
      .toBe(checkpointDigest({ kind: "decision", question: "Caf\u00e9", evidenceRefs: ["r\u00e9sum\u00e9"] }));
  });

  it("keeps evidenceRefs in their given order", () => {
    expect(checkpointDigest({ kind: "acceptance", criteria: "c", evidenceRefs: ["a", "b"] }))
      .not.toBe(checkpointDigest({ kind: "acceptance", criteria: "c", evidenceRefs: ["b", "a"] }));
  });

  it("covers every reviewed field", () => {
    const base = { kind: "decision", question: "q", criteria: "c", evidenceRefs: ["x"] };
    const d = checkpointDigest(base);
    for (const changed of [{ ...base, kind: "acceptance" }, { ...base, question: "q2" }, { ...base, criteria: "c2" }, { ...base, evidenceRefs: ["y"] }]) {
      expect(checkpointDigest(changed)).not.toBe(d);
    }
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("lenient reads", () => {
  it("keeps a ticket with a malformed or null checkpoint loadable", () => {
    for (const value of [null, "yes", { kind: "vote" }, 7]) {
      const t = TicketSchema.parse({ id: "T-001", title: "t", description: "", type: "task", status: "open", phase: null, order: 1, createdDate: "2026-09-27", completedDate: null, blockedBy: [], ownerCheckpoint: value });
      expect(t.ownerCheckpoint).toEqual(value);
      expect(parseOwnerCheckpoint(t).kind).toBe("unrecognized");
    }
  });

  it("counts JSON null as present, not absent", () => {
    const { byId } = scenario("null-checkpoint");
    expect(hasOwnerCheckpoint(byId("T-001"))).toBe(true);
    expect(checkpointState(byId("T-001"))).toBe("unrecognized");
    expect(checkpointReleases(byId("T-001"))).toBe(false);
  });

  it("an absent field is not a checkpoint", () => {
    const { byId } = scenario("ordinary-blocker");
    expect(hasOwnerCheckpoint(byId("T-001"))).toBe(false);
    expect(parseOwnerCheckpoint(byId("T-001")).kind).toBe("absent");
    expect(checkpointState(byId("T-001"))).toBeNull();
  });

  it("a lone surrogate or U+FFFD in reviewed content is unrecognized, never a throw or a release", () => {
    const valid = SCENARIO_SPECS.find((x) => x.name === "approved")!.tickets[0]!.ownerCheckpoint as Record<string, unknown>;
    const lone = ["a\uD800", "\uDC00b", "x\uDBFFy", "replacement \uFFFD"];
    for (const bad of lone) {
      for (const patch of [{ question: bad }, { criteria: bad }, { evidenceRefs: [bad] }]) {
        const t = TicketSchema.parse({ id: "T-001", title: "t", description: "", type: "task", status: "complete", phase: null, order: 1, createdDate: "2026-09-27", completedDate: "2026-09-27", blockedBy: [], ownerCheckpoint: { ...valid, ...patch } });
        expect(() => checkpointState(t)).not.toThrow();
        expect(checkpointState(t)).toBe("unrecognized");
        expect(checkpointReleases(t)).toBe(false);
        const state = makeState({ tickets: [t, TicketSchema.parse({ id: "T-002", title: "d", description: "", type: "task", status: "complete", phase: null, order: 2, createdDate: "2026-09-27", completedDate: "2026-09-27", blockedBy: ["T-001"] }) as Ticket] });
        expect(() => reassessCheckpoints(state, state.ticketByID("T-002")!)).not.toThrow();
        expect(pendingCheckpointBlockers(state, state.ticketByID("T-002")!)).toEqual(["T-001"]);
      }
    }
    // A well-formed pair is fine.
    expect(isWellFormedText("\uD83D\uDE00")).toBe(true);
  });

  it("bounds counters at MAX_SAFE_INTEGER", () => {
    expect(MAX_CHECKPOINT_COUNTER).toBe(9007199254740991);
  });

  it("reads evidence as absent, ok or malformed", () => {
    expect(parseCheckpointEvidence({}).kind).toBe("absent");
    expect(parseCheckpointEvidence({ checkpointEvidence: [] }).kind).toBe("ok");
    expect(parseCheckpointEvidence({ checkpointEvidence: "approved" }).kind).toBe("malformed");
    expect(parseCheckpointEvidence({ checkpointEvidence: null }).kind).toBe("malformed");
    expect(parseCheckpointEvidence({ checkpointEvidence: [{ checkpoint: "T-001", generation: 1, revision: 1, digest: "x", state: "approved" }] }).kind).toBe("malformed");
  });
});

describe("release predicates", () => {
  const states: [string, string, boolean][] = [
    ["pending", "pending", false],
    ["approved", "approved", true],
    ["approved-status-open", "pending", false],
    ["stale-stored-digest", "pending", false],
    ["resolution-generation-mismatch", "pending", false],
    ["acceptance-without-artifact", "pending", false],
    ["acceptance-with-artifact", "approved", true],
    ["retired", "retired", true],
    ["unknown-kind", "unrecognized", false],
    ["null-checkpoint", "unrecognized", false],
    ["soft-deleted-checkpoint", "unrecognized", false],
    ["resolution-revision-mismatch", "pending", false],
    ["resolution-digest-mismatch", "pending", false],
    ["counter-at-limit", "approved", true],
    ["generation-above-limit", "unrecognized", false],
    ["revision-above-limit", "unrecognized", false],
    ["replacement-character", "unrecognized", false],
  ];
  for (const [name, state, releases] of states) {
    it(`${name}: ${state}, ${releases ? "releases" : "blocks"}`, () => {
      const { state: ps, byId } = scenario(name);
      expect(checkpointState(byId("T-001"))).toBe(state);
      expect(checkpointReleases(byId("T-001"))).toBe(releases);
      expect(checkpointApproved(byId("T-001"))).toBe(state === "approved");
      expect(pendingCheckpointBlockers(ps, byId("T-002"))).toEqual(releases ? [] : ["T-001"]);
    });
  }

  it("a blocker without a checkpoint is not a checkpoint blocker", () => {
    const { state, byId } = scenario("ordinary-blocker");
    expect(pendingCheckpointBlockers(state, byId("T-002"))).toEqual([]);
  });
});

describe("reassessment table", () => {
  const rows: [string, string, string, boolean][] = [
    ["approved", "T-002", "2a", false],
    ["retired", "T-002", "2b", false],
    ["stale-stored-digest", "T-002", "2c", true],
    ["approved-evidence-on-retired", "T-002", "2c", true],
    ["retired-evidence-on-approved", "T-002", "2c", true],
    ["approved-generation-mismatch", "T-002", "2c", true],
    ["malformed-evidence", "T-002", "2c", true],
    ["legacy-approved", "T-002", "3b", false],
    ["legacy-reopened", "T-002", "3a", true],
    ["legacy-retirement", "T-002", "3b", false],
    ["legacy-pending", "T-002", "3c", true],
    ["legacy-approved-side-conflict", "T-002", "3c", true],
    ["legacy-retired-side-conflict", "T-002", "3b", false],
    ["retirement-adopted", "T-002", "2b", false],
    ["retirement-adopted", "T-003", "2c", true],
    ["unknown-kind", "T-002", "1", true],
    ["null-checkpoint", "T-002", "1", true],
    ["soft-deleted-checkpoint", "T-002", "1", true],
  ];
  for (const [name, id, row, flag] of rows) {
    it(`${name} ${id}: row ${row}, ${flag ? "FLAG" : "CLEAR"}`, () => {
      const { state, byId } = scenario(name);
      expect(reassessCheckpoints(state, byId(id))).toEqual([{ checkpoint: "T-001", row, flag }]);
      expect(needsReassessment(state, byId(id))).toBe(flag);
    });
  }

  it("evidence naming a checkpoint that no longer exists flags (row 1)", () => {
    const { state, byId } = scenario("missing-checkpoint");
    expect(reassessCheckpoints(state, byId("T-002"))).toEqual([{ checkpoint: "T-009", row: "1", flag: true }]);
  });

  it("a dependent that is not complete is never reassessed", () => {
    const { state, byId } = scenario("open-dependent");
    expect(reassessCheckpoints(state, byId("T-002"))).toEqual([]);
  });

  it("an ordinary blocker is never reassessed", () => {
    const { state, byId } = scenario("ordinary-blocker");
    expect(reassessCheckpoints(state, byId("T-002"))).toEqual([]);
  });
});
