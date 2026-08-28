import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeReviewCoverage,
  computeCommitSummary,
  isTicketShapedRef,
  isIssueShapedRef,
  type ReviewCoverage,
  type CommitTopology,
} from "../../src/core/review-coverage.js";
import { writeGateAckUnlocked, writeGateAckContested, scanForUnattributedGateAckWarnings, type GateAckDirScan } from "../../src/core/gate-ack-loader.js";
import { computeGateAckId, type GateAck, type GateAckPin } from "../../src/models/gate-ack.js";

const ARRANGEMENT_ID = "a-0123456789abcdef";
const OTHER_ARRANGEMENT_ID = "a-fedcba9876543210";
const GATE_NAME = "pre-commit-ack";
const TICKET_REF = "t-0123456789abcdef";
const ISSUE_REF = "i-0123456789abcdef";
const PARENT = "1".repeat(40);
const TREE = "2".repeat(40);
const OTHER_TREE = "3".repeat(40);
const TOPOLOGY: CommitTopology = { parentSha: PARENT, treeId: TREE };

function treePin(overrides: Partial<Extract<GateAckPin, { kind: "tree-digest" }>> = {}): GateAckPin {
  return { kind: "tree-digest", parentSha: PARENT, treeId: TREE, ...overrides };
}

function ack(overrides: Partial<GateAck> = {}): GateAck {
  const arrangementId = overrides.arrangementId ?? ARRANGEMENT_ID;
  const gateName = overrides.gateName ?? GATE_NAME;
  const ticketRef = overrides.ticketRef ?? TICKET_REF;
  const pin = overrides.pin ?? treePin();
  return {
    id: computeGateAckId(arrangementId, gateName, ticketRef, pin),
    arrangementId,
    gateName,
    ackRole: "pen",
    ticketRef,
    pin,
    decidedAt: "2026-08-28T00:00:00.000Z",
    reviewTrail: { present: false },
    contested: false,
    ...overrides,
  } as GateAck;
}

describe("ref shape classification", () => {
  it("distinguishes ticket-shaped from issue-shaped refs", () => {
    expect(isTicketShapedRef("T-476")).toBe(true);
    expect(isTicketShapedRef(TICKET_REF)).toBe(true);
    expect(isTicketShapedRef(ISSUE_REF)).toBe(false);
    expect(isIssueShapedRef("ISS-100")).toBe(true);
    expect(isIssueShapedRef(ISSUE_REF)).toBe(true);
    expect(isIssueShapedRef(TICKET_REF)).toBe(false);
  });
});

describe("computeReviewCoverage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "review-coverage-"));
    await mkdir(join(root, ".story", "arrangement-acks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("step 1: an issue ref is always notApplicable, regardless of any acks on disk", () => {
    const result = computeReviewCoverage(root, ISSUE_REF, TOPOLOGY, false);
    expect(result).toEqual({ gateAckCoverage: "notApplicable", reviewEvidence: "notApplicable" });
  });

  it("absent: a ticket ref with no gate-ack at all", () => {
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("absent");
    expect(result.reviewEvidence).toBe("notApplicable");
  });

  it("matched, with evidence", async () => {
    await writeGateAckUnlocked(ack({ reviewTrail: { present: true, verdict: "approve", codexSessionId: "sess-1", rounds: 2 } }), root);
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("matched");
    expect(result.reviewEvidence).toBe("present");
    expect(result.verdict).toBe("approve");
    expect(result.codexSessionId).toBe("sess-1");
    expect(result.rounds).toBe(2);
  });

  it("matched, without evidence", async () => {
    await writeGateAckUnlocked(ack(), root);
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("matched");
    expect(result.reviewEvidence).toBe("absent");
  });

  it("contested: scoped to the one matching commit, sibling commits for the same ticket unaffected", async () => {
    const written = await writeGateAckUnlocked(ack(), root);
    await writeGateAckContested(written.id, "disputed", root);
    const contestedResult = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(contestedResult.gateAckCoverage).toBe("contested");
    expect(contestedResult.reviewEvidence).toBe("notApplicable");

    // A sibling commit for the SAME ticket, different tree -- unaffected.
    const siblingTopology: CommitTopology = { parentSha: PARENT, treeId: OTHER_TREE };
    const siblingResult = computeReviewCoverage(root, TICKET_REF, siblingTopology, false);
    expect(siblingResult.gateAckCoverage).toBe("absent");
  });

  it("treeId alone matching but parentSha different does not count as a match", async () => {
    await writeGateAckUnlocked(ack({ pin: treePin({ parentSha: "9".repeat(40) }) }), root);
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("absent");
  });

  it("unknown: topology could not be computed (e.g. SHA-256 repo or root commit)", () => {
    const result = computeReviewCoverage(root, TICKET_REF, { parentSha: null, treeId: null }, false);
    expect(result.gateAckCoverage).toBe("unknown");
    expect(result.reviewEvidence).toBe("notApplicable");
  });

  it("unknown: a scoped loader warning for THIS ticket suppresses a confident absent", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await writeFile(
      join(dir, "g-brokenforticket0.json"),
      JSON.stringify({ id: "g-brokenforticket0", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: TICKET_REF, pin: { kind: "plan-hash" } }),
    );
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("unknown");
  });

  it("a broken ack attributed to a DIFFERENT ticket never taints this ticket's coverage", async () => {
    await writeGateAckUnlocked(ack({ reviewTrail: { present: true, verdict: "approve" } }), root);
    const dir = join(root, ".story", "arrangement-acks");
    await writeFile(
      join(dir, "g-brokenforother0.json"),
      JSON.stringify({ id: "g-brokenforother0", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: "t-fedcba9876543210", pin: { kind: "plan-hash" } }),
    );
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("matched");
  });

  it("notApplicable is unaffected by runHasUnattributedCorruption -- issue refs are never gate-ack-eligible", () => {
    const result = computeReviewCoverage(root, ISSUE_REF, TOPOLOGY, true);
    expect(result.gateAckCoverage).toBe("notApplicable");
  });

  describe("project-wide unattributed-corruption doctrine (pen's gate-1 ruling, T-476 precedent)", () => {
    it("forces unknown even for a ticket whose OWN scan is perfectly clean and would otherwise be matched", async () => {
      await writeGateAckUnlocked(ack({ reviewTrail: { present: true, verdict: "approve" } }), root);
      const clean = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
      expect(clean.gateAckCoverage).toBe("matched"); // sanity: would be matched without the flag

      const corrupted = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, true);
      expect(corrupted.gateAckCoverage).toBe("unknown");
      expect(corrupted.reviewEvidence).toBe("notApplicable");
    });

    it("forces unknown for a ticket that would otherwise read absent", () => {
      const corrupted = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, true);
      expect(corrupted.gateAckCoverage).toBe("unknown");
    });

    /** The pen's exact required test row. */
    it("one unparseable ack file with no recoverable ticketRef forces every ticket's coverage in the run to unknown", async () => {
      const dir = join(root, ".story", "arrangement-acks");
      // No ticketRef recoverable at all -- not even a malformed one.
      await writeFile(join(dir, "g-totallycorrupt0.json"), "{not json at all");
      await writeGateAckUnlocked(ack({ reviewTrail: { present: true, verdict: "approve" } }), root);
      await writeGateAckUnlocked(ack({ ticketRef: "t-fedcba9876543210", pin: treePin({ treeId: OTHER_TREE }) }), root);

      const warnings = scanForUnattributedGateAckWarnings(root);
      expect(warnings.length).toBeGreaterThan(0);
      const runHasUnattributedCorruption = warnings.length > 0;

      const first = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, runHasUnattributedCorruption);
      const second = computeReviewCoverage(root, "t-fedcba9876543210", { parentSha: PARENT, treeId: OTHER_TREE }, runHasUnattributedCorruption);
      expect(first.gateAckCoverage).toBe("unknown");
      expect(second.gateAckCoverage).toBe("unknown");
      // Never a confident matched/absent while the run-level flag is set.
      expect(["matched", "absent"]).not.toContain(first.gateAckCoverage);
      expect(["matched", "absent"]).not.toContain(second.gateAckCoverage);
    });
  });

  it("multipleMatches: two uncontested exact matches from different arrangements prefers the evidence-bearing one and flags it", async () => {
    await writeGateAckUnlocked(ack({ arrangementId: ARRANGEMENT_ID, decidedAt: "2026-08-28T01:00:00.000Z" }), root);
    await writeGateAckUnlocked(
      ack({ arrangementId: OTHER_ARRANGEMENT_ID, decidedAt: "2026-08-28T02:00:00.000Z", reviewTrail: { present: true, verdict: "approve" } }),
      root,
    );
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("matched");
    expect(result.reviewEvidence).toBe("present");
    expect(result.multipleMatches).toBe(true);
    expect(result.verdict).toBe("approve");
  });

  it("multipleMatches: BOTH evidence-bearing -- deterministic tie-break by earliest decidedAt, PROVEN independent of scan order by constructing the scan directly in both orders", () => {
    // Real ack records, but never written to disk -- fed straight into
    // computeReviewCoverage's gateAckScan param, in an EXPLICITLY reversed
    // array both ways, so the assertion cannot depend on `readdirSync`'s
    // unspecified enumeration order the way a filesystem-backed test would.
    const early = ack({ arrangementId: OTHER_ARRANGEMENT_ID, decidedAt: "2026-08-28T01:00:00.000Z", reviewTrail: { present: true, verdict: "reject" } });
    const late = ack({ arrangementId: ARRANGEMENT_ID, decidedAt: "2026-08-28T02:00:00.000Z", reviewTrail: { present: true, verdict: "approve" } });

    const scanEarlyFirst: GateAckDirScan = { entries: [{ kind: "ok", ack: early }, { kind: "ok", ack: late }], dirWarnings: [] };
    const scanLateFirst: GateAckDirScan = { entries: [{ kind: "ok", ack: late }, { kind: "ok", ack: early }], dirWarnings: [] };

    for (const scan of [scanEarlyFirst, scanLateFirst]) {
      const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false, scan);
      expect(result.gateAckCoverage).toBe("matched");
      expect(result.multipleMatches).toBe(true);
      // The EARLIEST decidedAt among the evidence-bearing matches wins, regardless of array order.
      expect(result.verdict).toBe("reject");
      expect(result.gateAckId).toBe(early.id);
    }
  });

  it("multipleMatches: neither evidence-bearing -- deterministic tie-break by earliest decidedAt", async () => {
    await writeGateAckUnlocked(ack({ arrangementId: ARRANGEMENT_ID, decidedAt: "2026-08-28T02:00:00.000Z" }), root);
    await writeGateAckUnlocked(ack({ arrangementId: OTHER_ARRANGEMENT_ID, decidedAt: "2026-08-28T01:00:00.000Z" }), root);
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("matched");
    expect(result.multipleMatches).toBe(true);
    expect(result.gateAckId).toBe(computeGateAckId(OTHER_ARRANGEMENT_ID, GATE_NAME, TICKET_REF, treePin()));
  });

  it("contested takes precedence over an uncontested exact match for the identical pin from a different arrangement", async () => {
    const contestedOne = await writeGateAckUnlocked(ack({ arrangementId: ARRANGEMENT_ID }), root);
    await writeGateAckContested(contestedOne.id, "disputed", root);
    await writeGateAckUnlocked(ack({ arrangementId: OTHER_ARRANGEMENT_ID, reviewTrail: { present: true, verdict: "approve" } }), root);
    const result = computeReviewCoverage(root, TICKET_REF, TOPOLOGY, false);
    expect(result.gateAckCoverage).toBe("contested");
  });
});

describe("computeCommitSummary", () => {
  const matchedWithEvidence: ReviewCoverage = { gateAckCoverage: "matched", reviewEvidence: "present" };
  const matchedNoEvidence: ReviewCoverage = { gateAckCoverage: "matched", reviewEvidence: "absent" };
  const absent: ReviewCoverage = { gateAckCoverage: "absent", reviewEvidence: "notApplicable" };
  const contested: ReviewCoverage = { gateAckCoverage: "contested", reviewEvidence: "notApplicable" };
  const unknown: ReviewCoverage = { gateAckCoverage: "unknown", reviewEvidence: "notApplicable" };
  const notApplicable: ReviewCoverage = { gateAckCoverage: "notApplicable", reviewEvidence: "notApplicable" };

  it("zero refs is unattributed, not vacuously fully-covered", () => {
    expect(computeCommitSummary([])).toBe("unattributed");
  });

  it("all notApplicable (issue-only refs) is not-applicable", () => {
    expect(computeCommitSummary([notApplicable, notApplicable])).toBe("not-applicable");
  });

  it("any contested wins over everything else", () => {
    expect(computeCommitSummary([matchedWithEvidence, contested, absent])).toBe("contested");
  });

  it("any unknown wins when nothing is contested", () => {
    expect(computeCommitSummary([matchedWithEvidence, unknown])).toBe("unknown");
  });

  it("any absent (with nothing contested/unknown) is needs-attention", () => {
    expect(computeCommitSummary([matchedWithEvidence, absent])).toBe("needs-attention");
  });

  it("every ref matched with evidence (notApplicable refs ignored) is fully-covered", () => {
    expect(computeCommitSummary([matchedWithEvidence, notApplicable])).toBe("fully-covered");
  });

  /** The pen's gate-1 catch: this combination previously fell through unassigned. */
  it("every ref matched but with NO evidence is needs-attention, never unassigned", () => {
    expect(computeCommitSummary([matchedNoEvidence])).toBe("needs-attention");
    expect(computeCommitSummary([matchedWithEvidence, matchedNoEvidence])).toBe("needs-attention");
  });
});
