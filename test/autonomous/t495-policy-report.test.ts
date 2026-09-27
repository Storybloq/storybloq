/**
 * T-495 WRITER, D3 to D5: the measurement record, the baseline adapter, and
 * the isolation boundary that makes "report-only" a property of the code.
 *
 * The record answers, for one ACCEPTED review round, what the review contract
 * WOULD have decided for each finding. It decides nothing itself. Three things
 * about that are load-bearing and each has its own tests below:
 *
 *  1. A reporter failure must be ABSENT, never an empty list. `findings: []`
 *     on a degraded record is the sentence "this round had no capped
 *     findings", which is exactly the false zero this ticket exists to remove.
 *  2. The baseline handed to the evaluator must be the stage's OWN decision.
 *     `evaluatePrinciplePolicy` refuses to invent one, so the adapter is where
 *     a wrong answer would enter and never be seen again.
 *  3. Nothing here may change a review outcome. The evaluator throws by design
 *     on a caller bug, so an unguarded call turns an integration slip into a
 *     failed live review round.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { bridgeCodeItem, planReceipt, type BridgeCodeItem } from "./helpers/bridge-receipts.js";
import {
  appendContractDelivery,
  readPolicyRecords,
  recordsEquivalent,
  reportRound,
  type ContractDeliveryEntry,
  type MeasuredPolicyRecord,
} from "../../src/autonomous/principle-policy-report.js";

const TICKET = "t-ce111n9000000001";

const CONTRACT = [
  "# Review contract",
  "",
  "## Outside this contract",
  "",
  "performance",
  "",
  "## Robustness",
  "",
  "Behaves under the inputs it will meet.",
  "",
  "Blocking: blocking",
  "",
  "## Quality",
  "",
  "Verified to do what it claims.",
  "",
  "Blocking: major",
  "",
].join("\n");

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-21",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", `${TICKET}.json`), JSON.stringify({
    id: TICKET, displayId: "T-901", title: "Measured", description: "A test.",
    type: "task", status: "inprogress", phase: "p1", order: 10,
    createdDate: "2026-08-21", completedDate: null, blockedBy: [],
  }));
  writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
  } as unknown as ResolvedRecipe;
}

function makeState(over: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000004c5",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: { id: TICKET, displayId: "T-901", title: "Measured", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    codeReviewRoundCounter: null, pendingCeilingEscalation: null,
    ...over,
  } as unknown as FullSessionState;
}

/** An unresolved minor naming a declared blocking-class principle. */
const MINOR_ROBUSTNESS = {
  severity: "minor", category: "logic", description: "Retry bound is off by one",
  principle: "robustness", disposition: "open",
};
/** An unresolved major naming NOTHING, which is the capping case. */
const MAJOR_UNNAMED = {
  severity: "major", category: "logic", description: "Token logged at debug level",
  disposition: "open",
};
/** An unresolved major naming a principle the contract does not declare. */
const MAJOR_UNDECLARED = {
  severity: "major", category: "logic", description: "Undeclared",
  principle: "tidiness", disposition: "open",
};
/** An unresolved critical naming an IMPLICIT principle, promoted without a declaration. */
const CRITICAL_IMPLICIT = {
  severity: "critical", category: "logic", description: "Implicit",
  principle: "correctness", disposition: "open",
};
/** An unresolved critical naming a DECLARED blocking-class principle. */
const CRITICAL_DECLARED = {
  severity: "critical", category: "logic", description: "Declared",
  principle: "robustness", disposition: "open",
};

let root: string;
let sDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t495-report-"));
  setupProject(root);
  sDir = join(root, ".story", "sessions", "s1");
  mkdirSync(sDir, { recursive: true });
});

afterEach(() => {
  item?.cleanup();
  item = null;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ISS-1332: every code round here is a codex round, which lands only through
// the bridge receipt gate. The item is built once per test, on first use, so a
// test that reports twice reviews one item twice rather than re-baselining.
let item: BridgeCodeItem | null = null;
const itemIn = (): BridgeCodeItem => (item ??= bridgeCodeItem(root));
const itemGit = (): Partial<FullSessionState> => ({ git: { branch: "main", mergeBase: itemIn().baseline, expectedHead: "abc123" } } as Partial<FullSessionState>);

async function runCodeRound(
  findings: unknown[],
  verdict = "request_changes",
  over: Partial<FullSessionState> = {},
): Promise<{ advance: unknown; ctx: StageContext }> {
  const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
  const ctx = new StageContext(root, sDir, makeState({ ...itemGit(), ...over }), makeRecipe());
  const advance = await new CodeReviewStage().report(ctx, {
    completedAction: "code_review_round", verdict, findings, reviewReceipts: [itemIn().receipt],
  } as never);
  return { advance, ctx };
}

function records(): readonly MeasuredPolicyRecord[] {
  return readPolicyRecords(sDir).records as readonly MeasuredPolicyRecord[];
}

function delivery(over: Partial<ContractDeliveryEntry> = {}): ContractDeliveryEntry {
  return {
    sessionId: "00000000-0000-0000-0000-0000000004c5",
    target: TICKET, itemAttemptId: null, stage: "code", generation: 1, roundNum: 1,
    leg: "packet", reviewMdIncluded: true, omissionReason: null,
    contentHash: "baseline-hash", sourceChars: 10, sourceBytes: 10, deliveredChars: 10,
    truncated: false, truncatedAtChars: null, timestamp: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

// ── D3: one record per accepted round ────────────────────────────

describe("T-495 D3: a record is written for an ACCEPTED round and only then", () => {
  it("T1: one accepted round yields exactly ONE record, not one per finding", async () => {
    await runCodeRound([MINOR_ROBUSTNESS, MAJOR_UNNAMED, CRITICAL_DECLARED]);
    const recs = records();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("measured");
    expect(recs[0]!.findings).toHaveLength(3);
  });

  it("T2: a bounced contradictory-approve round yields NO record", async () => {
    // `approve` with an unresolved critical is refused at code-review.ts:655,
    // BEFORE the round is recorded. A reporter placed above that guard measures
    // a round that never happened.
    const { advance } = await runCodeRound([CRITICAL_DECLARED], "approve");
    expect((advance as { action: string }).action).toBe("retry");
    expect(records()).toHaveLength(0);
  });

  it("T4a: ISOLATION -- the reporter demonstrably RUNS and changes no action", async () => {
    // BOTH halves matter. Asserting only that the action is unchanged passes
    // vacuously on a round that bounced before the reporter was reached, which
    // is why the record assertion is here rather than in a separate test.
    //
    // `timestamp` and the time-derived attempt ids move on every run and are
    // not what "unchanged" means, so they are stripped BY NAME and the stripped
    // set is asserted non-trivial: a comparison over two empty objects would be
    // the same false zero this ticket is about.
    const VOLATILE = new Set(["timestamp", "reviewAttemptId", "itemAttemptId", "backendRunId"]);
    const stable = (rounds: readonly unknown[]): string => JSON.stringify(
      rounds.map((r) => Object.fromEntries(
        Object.entries(r as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)),
      )),
    );

    const a = await runCodeRound([MINOR_ROBUSTNESS], "request_changes");
    expect(records()).toHaveLength(1);
    const actionWith = JSON.stringify(a.advance as Record<string, unknown>);
    const stateWith = stable(a.ctx.state.reviews.code);
    // The comparison has real content: verdict, counts and the artifact status
    // all survive the strip.
    expect(stateWith).toContain("request_changes");
    expect(Object.keys(a.ctx.state.reviews.code[0]!).length).toBeGreaterThan(VOLATILE.size);

    // THE CONTROL RUN GENUINELY DISABLES THE REPORTER.
    //
    // An earlier form removed REVIEW.md and the session directory and called
    // that a control. It is not: `reportRound` still runs, still evaluates an
    // absent contract, and still appends a measured record, so BOTH runs carry
    // whatever side effects the reporter has and the comparison could never
    // show one. Codex found it. The reporter is now replaced by a no-op, which
    // is the only version of this test that can fail.
    rmSync(sDir, { recursive: true, force: true });
    mkdirSync(sDir, { recursive: true });
    const mod = await import("../../src/autonomous/principle-policy-report.js");
    const spy = vi.spyOn(mod, "reportRound")
      .mockReturnValue({ written: "none", failedAt: null });
    const b = await runCodeRound([MINOR_ROBUSTNESS], "request_changes");
    // The control really was reporter-free.
    expect(spy).toHaveBeenCalled();
    expect(readPolicyRecords(sDir).records).toHaveLength(0);
    expect(JSON.stringify(b.advance as Record<string, unknown>)).toBe(actionWith);
    expect(stable(b.ctx.state.reviews.code)).toBe(stateWith);
  });

  it("T4b: PROJECTION -- an unresolved MINOR naming a blocking principle is floor-suppressed", async () => {
    // T4a cannot see this: a wrong projection changes no action, so isolation
    // holds either way and the number is silently wrong.
    await runCodeRound([MINOR_ROBUSTNESS]);
    const f = records()[0]!.findings[0]!;
    expect(f.floorSuppressed).toBe(true);
    expect(f.projectedSeverity).toBe(f.actualSeverity);
    expect(f.policyBlock).toBe("baseline");
    expect(f.outcome).toBe("floor-suppressed");
    const gate = records()[0]!.gate;
    expect(gate.hasCriticalOrMajor).toBe(gate.baselineHasCriticalOrMajor);
    expect(gate.hasUnresolvedCritical).toBe(gate.baselineHasUnresolvedCritical);
  });

  it("T4c: an unresolved major naming NOTHING is `capped-names-none`, not floor-suppressed", async () => {
    await runCodeRound([MAJOR_UNNAMED]);
    const f = records()[0]!.findings[0]!;
    expect(f.outcome).toBe("capped-names-none");
    expect(f.projectedSeverity).toBe("suggestion");
    expect(f.floorSuppressed).toBe(false);
  });

  it("the four other outcomes are each distinguishable, not collapsed into two words", async () => {
    await runCodeRound([MAJOR_UNDECLARED, CRITICAL_IMPLICIT, CRITICAL_DECLARED]);
    const fs = records()[0]!.findings;
    expect(fs.map((f) => f.outcome)).toEqual([
      "capped-names-undeclared", "promoted-implicit", "promoted-declared",
    ]);
    expect(fs[0]!.undeclaredName).toBe("tidiness");
  });
});

// ── D3: the degraded shape ───────────────────────────────────────

/** A predicate that answers true until the nth call, then throws. */
function onCall(n: number, boom: () => never): (f: unknown) => boolean {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls >= n) boom();
    return true;
  };
}

describe("T-495 D3: a degraded record is ABSENT, never empty", () => {
  it("T16: a degraded record has no `findings` key and no `gate` key at all", () => {
    const out = reportRound({
      sessionDir: sDir, projectRoot: root,
      sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
      reviewAttemptId: "ra-1", artifactFileName: "a.json", artifactContentHash: "h",
      stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
      findings: [MAJOR_UNNAMED],
      // The predicate is called ONCE by the baseline adapter and again inside
      // the evaluator, so throwing unconditionally lands at `baselines` and
      // this test would pass while never reaching the step it names. Throwing
      // on the second call is what puts the failure in the evaluator.
      isRoundBlocker: onCall(2, () => { throw new Error("injected"); }),
      baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
      stageNextAction: "IMPLEMENT",
    });
    expect(out.written).toBe("degraded");
    const rec = readPolicyRecords(sDir).records[0]! as Record<string, unknown>;
    expect(rec.kind).toBe("degraded");
    expect("findings" in rec).toBe(false);
    expect("gate" in rec).toBe(false);
    expect(rec.failedAt).toBe("project");
    expect(typeof rec.error).toBe("string");
  });

  /**
   * A COMPLETE degraded record. The two tests below differ by exactly one key,
   * so a rejection is attributable to that key and to nothing else. An earlier
   * pair used a fixture missing half the identity fields and called it
   * well-formed: it passed only because the validator was too shallow, so it
   * codified the weakness and would have REJECTED a correctly strengthened
   * validator. Codex found it in round 2.
   */
  const DEGRADED = {
    kind: "degraded", sessionId: "s", itemId: TICKET, target: TICKET,
    itemAttemptId: null, reviewAttemptId: "ra-1",
    artifactFileName: "a.json", artifactContentHash: "h",
    stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
    failedAt: "project", error: "x", timestamp: "2026-09-10T00:00:00.000Z",
  };

  function writeRecordLine(record: unknown): void {
    writeFileSync(join(sDir, "principle-policy.jsonl"), `${JSON.stringify(record)}\n`, "utf-8");
  }

  it("T16d: a well-formed degraded record reads back", () => {
    writeRecordLine(DEGRADED);
    const read = readPolicyRecords(sDir);
    expect(read.records).toHaveLength(1);
    expect(read.unreadableLines).toBe(0);
  });

  it("T16c: the SAME record plus a `findings` key is REJECTED on the way back in", () => {
    // The union is enforced on READ as well as on write. A hand-edited or torn
    // line shaped `{kind:"degraded", findings:[]}` would otherwise be read as
    // "this round had no capped findings", which is the exact false zero the
    // union exists to refuse, arriving through the door nobody guarded. Its
    // mutant survived the gate until this test existed.
    writeRecordLine({ ...DEGRADED, findings: [] });
    const read = readPolicyRecords(sDir);
    expect(read.records).toHaveLength(0);
    expect(read.unreadableLines).toBe(1);
  });

  it("T16e: a MEASURED record is validated to the depth a consumer reads it", () => {
    // A guard that only asks `Array.isArray(findings)` admits `findings:
    // [null]` and `gate: []` and hands them back fully typed: the consumer
    // crashes on a field access, or aggregates numbers that mean nothing. Codex
    // found this after the shallow guard had already been added for round 1 --
    // a validator checking the wrong depth is the same absence reading as a
    // zero, one layer down.
    const base = {
      ...DEGRADED, kind: "measured",
      evaluatedContentHash: "eh", contractStatus: "active", contractActive: true,
      effectivePolicy: { alwaysBlock: [], neverBlock: [] },
      delivered: null, deliveryBinding: "absent",
      deliveryVerified: false, deliveryVerifiedBy: null,
      findings: [], gate: {
        hasCriticalOrMajor: false, hasUnresolvedCritical: false,
        baselineHasCriticalOrMajor: false, baselineHasUnresolvedCritical: false,
        policyBlockedIndices: [], forcedLandingAllowed: true,
      },
      stageNextAction: null, floorSuppressedMinorCount: 0, floorSuppressedTotal: 0,
    };
    delete (base as Record<string, unknown>).failedAt;
    delete (base as Record<string, unknown>).error;

    // The complete form really is accepted, so every rejection below is
    // attributable to the one field it changes.
    writeRecordLine(base);
    expect(readPolicyRecords(sDir).records).toHaveLength(1);

    for (const [label, mutation] of [
      ["a null inside findings", { findings: [null] }],
      ["gate as an array", { gate: [] }],
      ["an unknown deliveryBinding", { deliveryBinding: "probably" }],
      ["a missing reviewAttemptId", { reviewAttemptId: undefined }],
      ["an unknown finding outcome", { findings: [{
        index: 0, principle: null, coverage: "inside", actualSeverity: "major",
        projectedSeverity: "major", policyBlock: "baseline", floorSuppressed: false,
        outcome: "invented", reason: "r", undeclaredName: null,
        baseline: { severity: "major", blocking: true },
      }] }],
      ["a negative counter", { floorSuppressedTotal: -1 }],
      ["an unknown kind", { kind: "speculative" }],
    ] as const) {
      writeRecordLine({ ...base, ...mutation });
      const read = readPolicyRecords(sDir);
      expect(read.records, label).toHaveLength(0);
      expect(read.unreadableLines, label).toBe(1);
    }
  });

  it("T16b: a failure in the BASELINE adapter is named `baselines`, not `project`", () => {
    // The five steps are distinguishable or `failedAt` says nothing useful:
    // a reader cannot tell an integration bug from an evaluator bug if both
    // arrive under one word.
    const out = reportRound({
      sessionDir: sDir, projectRoot: root,
      sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
      reviewAttemptId: "ra-1", artifactFileName: "a.json", artifactContentHash: "h",
      stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
      findings: [MAJOR_UNNAMED],
      isRoundBlocker: onCall(1, () => { throw new Error("injected"); }),
      baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
      stageNextAction: null,
    });
    expect(out.written).toBe("degraded");
    expect((readPolicyRecords(sDir).records[0] as Record<string, unknown>).failedAt)
      .toBe("baselines");
  });
});

// ── D5: the isolation boundary ───────────────────────────────────

describe("T-495 D5: the boundary is BUILT and cannot throw", () => {
  it("T18a: a projection throw is contained AND named `project`", () => {
    // `onCall(2)`, not an unconditional throw: the predicate is called once by
    // the baseline adapter first, so an unconditional throw lands at
    // `baselines` and this test would pass while never reaching the step in its
    // own name. Codex found it, and the assertion on `failedAt` is what stops
    // it recurring.
    let out: { written: string; failedAt: string | null } | undefined;
    expect(() => {
      out = reportRound({
        sessionDir: sDir, projectRoot: root,
        sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
        reviewAttemptId: "ra-1", artifactFileName: "a.json", artifactContentHash: "h",
        stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
        findings: [MAJOR_UNNAMED],
        isRoundBlocker: onCall(2, () => { throw new Error("injected"); }),
        baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
        stageNextAction: null,
      });
    }).not.toThrow();
    expect(out!.failedAt).toBe("project");
  });

  it("T18b: an APPEND failure is contained, named `append`, and writes nothing", () => {
    // The DELIVERY LOOKUP MUST STILL WORK, so the failure is genuinely at the
    // append. An earlier form replaced the whole session directory with a file,
    // which makes reading `contract-delivery.jsonl` fail with ENOTDIR at
    // `lookup`: the test asserted `written === "none"` and passed without ever
    // reaching the step it names. Codex found it. Here only the policy log is
    // unwritable, as a directory sitting where the file belongs.
    mkdirSync(join(sDir, "principle-policy.jsonl"));
    let out: { written: string; failedAt: string | null } | undefined;
    expect(() => {
      out = reportRound({
        sessionDir: sDir, projectRoot: root,
        sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
        reviewAttemptId: "ra-1", artifactFileName: "a.json", artifactContentHash: "h",
        stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
        findings: [MAJOR_UNNAMED], isRoundBlocker: () => true,
        baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
        stageNextAction: null,
      });
    }).not.toThrow();
    expect(out!.written).toBe("none");
    expect(out!.failedAt).toBe("append");
    // Nothing was written, so the reader sees measurement-absent and correctly
    // declines to guess the cause.
    expect(readPolicyRecords(sDir).records).toHaveLength(0);
  });

  it("T18c: a delivery-log READ failure is contained and named", () => {
    // A directory where the log file belongs: the read throws EISDIR.
    mkdirSync(join(sDir, "contract-delivery.jsonl"));
    const out = reportRound({
      sessionDir: sDir, projectRoot: root,
      sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
      reviewAttemptId: "ra-1", artifactFileName: "a.json", artifactContentHash: "h",
      stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
      findings: [MAJOR_UNNAMED], isRoundBlocker: () => true,
      baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
      stageNextAction: null,
    });
    expect(out.written).toBe("degraded");
    expect((readPolicyRecords(sDir).records[0] as Record<string, unknown>).failedAt).toBe("lookup");
  });
});

// ── D3: delivery binding lands on the record ─────────────────────

describe("T-495 D3: deliveryVerified is a TWO-conjunct computed field", () => {
  function runWith(deliveries: ContractDeliveryEntry[], baselineHash: string) {
    for (const d of deliveries) appendContractDelivery(sDir, d);
    return reportRound({
      sessionDir: sDir, projectRoot: root, windowBaselineHash: baselineHash,
      sessionId: "00000000-0000-0000-0000-0000000004c5", itemId: TICKET, target: TICKET,
      itemAttemptId: null, reviewAttemptId: "ra-1",
      artifactFileName: "a.json", artifactContentHash: "h",
      stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
      findings: [MAJOR_UNNAMED], isRoundBlocker: () => true,
      baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
      stageNextAction: null,
    });
  }

  it("T48a: exact binding AND a delivered hash equal to baseline is verified", () => {
    runWith([delivery()], "baseline-hash");
    const rec = records()[0]!;
    expect(rec.deliveryBinding).toBe("exact");
    expect(rec.deliveryVerified).toBe(true);
    expect(rec.deliveryVerifiedBy).toBe("key-binding");
  });

  it("T48b: an exact binding whose delivered hash DIFFERS is not verified", () => {
    runWith([delivery({ contentHash: "other-hash" })], "baseline-hash");
    const rec = records()[0]!;
    expect(rec.deliveryBinding).toBe("exact");
    expect(rec.deliveryVerified).toBe(false);
    expect(rec.deliveryVerifiedBy).toBeNull();
    // The delivered hash is still RECORDED. This round is the one the
    // delivered-versus-evaluated metric exists to reveal, and a record that
    // dropped the hash on failing verification could never supply it.
    expect(rec.delivered!.contentHash).toBe("other-hash");
  });

  it("T48c: a matching hash with a WEAK binding is not verified", () => {
    runWith([delivery({ leg: "lens", target: null, generation: null })], "baseline-hash");
    const rec = records()[0]!;
    expect(rec.deliveryBinding).toBe("weak");
    expect(rec.deliveryVerified).toBe(false);
  });

  it("T48e: an OMITTED-BY-FIT round whose recorded hash equals the baseline is NOT verified", () => {
    // The case the binding conjunct exists for, and the one a hash-only test
    // cannot reach. A packet whose budget fit dropped the contract section has
    // still READ and HASHED the file, so its recorded `contentHash` EQUALS the
    // baseline while the reviewer received nothing. Verifying on the hash alone
    // would certify delivery for a round that had none, which is precisely the
    // reading this measurement exists to make impossible.
    //
    // Found by a surviving mutant, not by review: dropping the binding conjunct
    // left every earlier test passing.
    runWith([delivery({ reviewMdIncluded: false, omissionReason: "dropped-by-budget-fit" })],
      "baseline-hash");
    const rec = records()[0]!;
    expect(rec.deliveryBinding).toBe("omitted-by-fit");
    // The equality really holds, so the mutant this refuses is really reachable.
    expect(rec.delivered!.contentHash).toBe("baseline-hash");
    expect(rec.delivered!.reviewMdIncluded).toBe(false);
    expect(rec.deliveryVerified).toBe(false);
    expect(rec.deliveryVerifiedBy).toBeNull();
  });

  it("T48d: nothing else can make it true, and there is no third conjunct to fail", () => {
    // Refuses a three-conjunct version that re-derived principle completeness
    // by parsing delivered text: on truncated text that parse measures the
    // surviving subset and returns true, so the conjunct could never fail.
    runWith([delivery()], "baseline-hash");
    const rec = records()[0]! as unknown as Record<string, unknown>;
    expect("principleListComplete" in rec).toBe(false);
  });
});

// ── D4: the baseline adapter ─────────────────────────────────────

describe("T-495 D4: the baseline is the STAGE's own decision", () => {
  it("T26: the effective blocking policy is passed to the evaluator and persisted", async () => {
    // `readBlockingPolicy`'s default alwaysBlock is NON-EMPTY, so omitting the
    // lists is not a neutral default: a finding the configuration exempts would
    // be reported as capped or promoted, describing a flip that would not
    // happen.
    const cfgPath = join(root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.recipeOverrides = { blockingPolicy: { alwaysBlock: ["injection"], neverBlock: ["logic"] } };
    writeFileSync(cfgPath, JSON.stringify(cfg));

    await runCodeRound([MAJOR_UNNAMED]);
    const rec = records()[0]!;
    expect(rec.effectivePolicy).toEqual({ alwaysBlock: ["injection"], neverBlock: ["logic"] });
    // `logic` is on neverBlock, so the backend's own decision is preserved and
    // the finding is NOT capped despite naming no principle.
    expect(rec.findings[0]!.outcome).toBe("unchanged");
  });

  it("T24: PLAN_REVIEW records a REAL baselineHasUnresolvedCritical, not false", async () => {
    const { PlanReviewStage } = await import("../../src/autonomous/stages/plan-review.js");
    const ctx = new StageContext(root, sDir, makeState({ state: "PLAN_REVIEW" }), makeRecipe());
    // No plan.md is written, and the gate reads a missing plan.md as "".
    await new PlanReviewStage().report(ctx, {
      completedAction: "plan_review_round", verdict: "revise", findings: [CRITICAL_DECLARED], reviewReceipts: planReceipt(""),
    } as never);
    const rec = records()[0]!;
    expect(rec.gate.baselineHasUnresolvedCritical).toBe(true);
    expect(rec.gate.baselineHasCriticalOrMajor).toBe(true);
  });

  it("T25: PLAN_REVIEW records stageNextAction null, which is the truth at the write site", async () => {
    const { PlanReviewStage } = await import("../../src/autonomous/stages/plan-review.js");
    const ctx = new StageContext(root, sDir, makeState({ state: "PLAN_REVIEW" }), makeRecipe());
    await new PlanReviewStage().report(ctx, {
      completedAction: "plan_review_round", verdict: "revise", findings: [MAJOR_UNNAMED], reviewReceipts: planReceipt(""),
    } as never);
    expect(records()[0]!.stageNextAction).toBeNull();
  });

  it("T25b: CODE_REVIEW records a stageNextAction string", async () => {
    await runCodeRound([MAJOR_UNNAMED]);
    expect(typeof records()[0]!.stageNextAction).toBe("string");
  });
});

// ── D3: canonical equivalence ────────────────────────────────────

describe("T-495 D3: canonical equivalence EXCLUDES the append metadata", () => {
  function base(over: Record<string, unknown> = {}): MeasuredPolicyRecord {
    return {
      kind: "measured", sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
      reviewAttemptId: "ra-1", artifactFileName: "a.json", artifactContentHash: "h",
      stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
      evaluatedContentHash: "eh", contractStatus: "active", contractActive: true,
      effectivePolicy: { alwaysBlock: ["injection"], neverBlock: [] },
      delivered: null, deliveryBinding: "absent", deliveryVerified: false, deliveryVerifiedBy: null,
      findings: [], gate: {
        hasCriticalOrMajor: false, hasUnresolvedCritical: false,
        baselineHasCriticalOrMajor: false, baselineHasUnresolvedCritical: false,
        policyBlockedIndices: [], forcedLandingAllowed: true,
      },
      stageNextAction: null, floorSuppressedMinorCount: 0, floorSuppressedTotal: 0,
      timestamp: "2026-09-10T00:00:00.000Z",
      ...over,
    } as unknown as MeasuredPolicyRecord;
  }

  it("T15a: two records differing ONLY in timestamp are equivalent", () => {
    // Comparing whole records means no duplicate ever collapses, because every
    // append carries a fresh timestamp. That is the mutant this refuses.
    expect(recordsEquivalent(base(), base({ timestamp: "2026-09-11T00:00:00.000Z" }))).toBe(true);
  });

  it("T15c: two REAL reportRound calls for one attempt collapse; a changed input does not", () => {
    // The plan's own fixture is "two actual calls, not copied objects", and the
    // difference matters: hand-built records can only exercise the helper's
    // field list, while two real emissions also catch a PRODUCTION field that
    // moves between replays and would stop equivalent reports collapsing.
    // Codex found the gap.
    const call = (findings: readonly unknown[]) => reportRound({
      sessionDir: sDir, projectRoot: root, windowBaselineHash: "baseline-hash",
      sessionId: "s", itemId: TICKET, target: TICKET, itemAttemptId: null,
      reviewAttemptId: "ra-replay", artifactFileName: "a.json", artifactContentHash: "h",
      stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
      findings, isRoundBlocker: () => true,
      baselineHasCriticalOrMajor: true, baselineHasUnresolvedCritical: false,
      stageNextAction: "IMPLEMENT",
    });
    // A CONTROLLED CLOCK. Two consecutive calls can land in the same
    // millisecond, and an earlier form papered over that with an `||` disjunct
    // accepting equal timestamps -- which made the whole point of using real
    // emissions unverifiable. Codex found it.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
      call([MAJOR_UNNAMED]);
      vi.setSystemTime(new Date("2026-09-10T00:00:05.000Z"));
      call([MAJOR_UNNAMED]);
      vi.setSystemTime(new Date("2026-09-10T00:00:09.000Z"));
      call([CRITICAL_DECLARED]);
    } finally {
      vi.useRealTimers();
    }

    const [first, second, third] = records();
    // The timestamps DIFFER, so the collapse below is not trivially true.
    expect(first!.timestamp).not.toBe(second!.timestamp);
    expect(recordsEquivalent(first!, second!)).toBe(true);
    expect(recordsEquivalent(first!, third!)).toBe(false);
  });

  it("T15b: a changed evaluation input makes them NOT equivalent", () => {
    expect(recordsEquivalent(base(), base({ evaluatedContentHash: "different" }))).toBe(false);
  });

  it("T27a: effectivePolicy is INSIDE canonical equivalence", () => {
    // A week during which the configuration changed must read as a conflicting
    // evaluation rather than as a change in reviewer behaviour.
    expect(recordsEquivalent(
      base(),
      base({ effectivePolicy: { alwaysBlock: [], neverBlock: [] } }),
    )).toBe(false);
  });

  it("T27b: records for DIFFERENT attempts are never compared for equivalence", () => {
    expect(recordsEquivalent(base(), base({ reviewAttemptId: "ra-2" }))).toBe(false);
  });
});

// ── D3: the write site ───────────────────────────────────────────

describe("T-495 D3: the record is written BEFORE writeState", () => {
  it("T14: a crash at writeState still leaves the measurement on disk", async () => {
    // Order: artifact, in-memory upsert, P3 append, writeState. A record
    // written after writeState is lost on exactly the interruption the
    // reconciliation path exists to survive.
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, makeState(itemGit()), makeRecipe());
    // Armed on the state write that RECORDS THE ROUND, not on the first one:
    // `prepareReviewRound` writes the pending envelope before the artifact
    // exists, so crashing there ends the round before the reporter is reached
    // and the test would pass having proved nothing.
    const original = ctx.writeState.bind(ctx);
    let armedOn = 0;
    vi.spyOn(ctx, "writeState").mockImplementation((patch) => {
      if (patch !== null && typeof patch === "object" && "reviews" in patch) {
        armedOn += 1;
        throw new Error("crash at writeState");
      }
      return original(patch);
    });
    await expect(new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round", verdict: "request_changes", findings: [MAJOR_UNNAMED], reviewReceipts: [itemIn().receipt],
    } as never)).rejects.toThrow("crash at writeState");
    // The crash really happened at the point this test claims.
    expect(armedOn).toBe(1);
    expect(records()).toHaveLength(1);
  });
});
