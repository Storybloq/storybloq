/**
 * ISS-958 section 6: every catch a state-write error can reach in src, every
 * promise handler on a writer, every writer passed as a value, and every call
 * whose callee the scan cannot resolve, is declared in
 * src/autonomous/state-write-policy.ts. A new one fails here until it is given
 * a policy; a removed one fails until its key is dropped. The lock contract
 * (tiers, context constructions, lock lifetime, the lock entry) holds on src.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scanStateWrites, type ScanResult } from "./_state-write-scanner.js";
import {
  AWAITED_CALLBACK_PRIMITIVES,
  CONTEXT_CONSTRUCTIONS,
  CONTEXT_PARAMS,
  INJECTED_CALLBACK_SLOTS,
  LOCK_ENTRIES,
  LOCK_HELD_BY_CONTRACT,
  LOCK_HELD_VIA_CALLER,
  RESULT_ALLOWLIST,
  SINK_ALLOWLIST,
  STATE_WRITE_CATCHES,
  STATE_WRITE_EDGES,
  STATE_WRITE_UNRESOLVED,
  TEST_ONLY_EXPORTS,
  TEST_SEAM_SLOTS,
  UNFOLLOWED_SINK_CHAINS,
} from "../../src/autonomous/state-write-policy.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function srcProgram(): ts.Program {
  const configPath = join(PKG, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PKG);
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
}

/**
 * Plan 1b: the functions holding a catch or handler a state write reaches, by
 * file#fn. Pinned both ways, so the scan can neither lose one nor gain one
 * without this list changing in review.
 */
const PLAN_1B_FUNCTIONS: readonly string[] = [
  "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked",
  "src/autonomous/candidate-recovery.ts#commitCandidateTakeoverLocked",
  "src/autonomous/guide.ts#handleAutonomousGuide",
  "src/autonomous/guide.ts#handlePreCompact",
  "src/autonomous/guide.ts#handleResume",
  "src/autonomous/guide.ts#handleStartAfterNormalization",
  "src/autonomous/guide.ts#publishResume",
  "src/autonomous/guide.ts#recoverPendingMutation",
  "src/autonomous/guide.ts#trySupersedeFinishedOrphan",
  "src/autonomous/plan-context.ts#runGoverningGate",
  "src/autonomous/plan-context.ts#withPlanContext",
  "src/autonomous/retired-limit-park.ts#normalizeRetiredLimitParkLocked",
  "src/autonomous/retired-limit-park.ts#normalizeRetiredParksBestEffort",
  "src/autonomous/retired-limit-park.ts#publish",
  "src/autonomous/retired-limit-park.ts#strip",
  "src/autonomous/session.ts#createSession",
  "src/autonomous/session.ts#writeSessionWithEvent",
  "src/autonomous/stages/complete.ts#CompleteStage.tryCheckpoint",
  "src/autonomous/stages/handover.ts#HandoverStage.report",
  "src/autonomous/stages/pick-ticket.ts#PickTicketStage.handleIssuePick",
  "src/autonomous/stages/types.ts#StageContext.finalizeSession",
  "src/autonomous/stages/types.ts#StageContext.writeState",
  "src/cli/commands/brief.ts#handleBriefRebase",
  "src/cli/commands/session-compact.ts#handleSessionClearCompact",
  "src/cli/commands/session-compact.ts#handleSessionCompactPrepare",
  "src/cli/commands/session-compact.ts#handleSessionLimitStop",
  "src/cli/commands/session-compact.ts#handleSessionResumePrompt",
  "src/cli/commands/session-compact.ts#handleSessionStop",
  "src/cli/housekeeping.ts#preCommandHousekeeping",
  "src/cli/limit-retirement-entry.ts#retireLimitAutoResumeBestEffort",
  "src/cli/register.ts#registerSessionCommand",
  "src/cli/register.ts#runCatalogWrite",
  "src/core/limit-retirement.ts#runLimitRetirement",
  "src/mcp/index.ts#<module>",
  "src/mcp/index.ts#registerDegradedTools",
];

/**
 * The registered catches the scan classifies as contained (they swallow
 * rather than propagate). Pinned so a catch that changes shape is reviewed.
 */
const CONTAINED_CATCHES: readonly string[] = [
  "src/autonomous/stages/complete.ts#CompleteStage.tryCheckpoint#catch#2",
  "src/autonomous/stages/pick-ticket.ts#PickTicketStage.handleIssuePick#catch#3",
  "src/cli/commands/session-compact.ts#handleSessionLimitStop#catch#1",
  "src/cli/commands/session-compact.ts#handleSessionResumePrompt#catch#6",
  "src/cli/housekeeping.ts#preCommandHousekeeping#catch#4",
  "src/mcp/index.ts#registerDegradedTools#catch#4",
];

let cached: ScanResult | undefined;
function scan(): ScanResult {
  cached ??= scanStateWrites(srcProgram(), {
    base: PKG,
    rootFile: "src/autonomous/session.ts",
    rootName: "writeSessionSync",
    lockName: "withSessionLock",
    registry: {
      catches: STATE_WRITE_CATCHES,
      edges: STATE_WRITE_EDGES,
      lockHeldByContract: LOCK_HELD_BY_CONTRACT,
      sinks: SINK_ALLOWLIST,
      results: RESULT_ALLOWLIST,
      testOnlyExports: TEST_ONLY_EXPORTS,
      unresolved: STATE_WRITE_UNRESOLVED,
      lockHeldViaCaller: LOCK_HELD_VIA_CALLER,
      contextConstructions: CONTEXT_CONSTRUCTIONS,
      lockEntries: LOCK_ENTRIES,
      awaitedCallbackPrimitives: AWAITED_CALLBACK_PRIMITIVES,
      injectedCallbackSlots: INJECTED_CALLBACK_SLOTS,
      contextParams: CONTEXT_PARAMS,
      testSeamSlots: TEST_SEAM_SLOTS,
      unfollowedSinkChains: UNFOLLOWED_SINK_CHAINS,
    },
    lockContext: { file: "src/autonomous/stages/types.ts", className: "StageContext", stageInterface: "WorkflowStage" },
  });
  return cached;
}

const fnOf = (key: string) => key.split("#").slice(0, 2).join("#");

describe("ISS-958 state-write enforcement over src", () => {
  it("every reachable catch, handler, value escape and unresolved call is registered, and no key is stale", () => {
    expect(scan().errors).toEqual([]);
    expect(scan().writers.length).toBeGreaterThan(1);
  }, 120_000);

  it("the found sites are exactly the registered catches and edges, and the contained ones are the pinned set", () => {
    const found = scan().found;
    expect([...found.keys()].sort()).toEqual([...Object.keys(STATE_WRITE_CATCHES), ...Object.keys(STATE_WRITE_EDGES), ...CONTAINED_CATCHES].sort());
    expect([...found].filter(([, v]) => v === "contained").map(([k]) => k).sort()).toEqual([...CONTAINED_CATCHES].sort());
  }, 120_000);

  it("the registered and contained catches sit in exactly the plan 1b functions", () => {
    const fns = new Set([...Object.keys(STATE_WRITE_CATCHES), ...CONTAINED_CATCHES].map(fnOf));
    expect([...fns].sort()).toEqual([...PLAN_1B_FUNCTIONS].sort());
  }, 120_000);

  it("every reviewed UNRESOLVED entry names its function, its callee and a reason", () => {
    for (const [key, reason] of Object.entries(STATE_WRITE_UNRESOLVED)) {
      expect(key.split("#").length).toBeGreaterThanOrEqual(4);
      expect(reason.trim().length).toBeGreaterThan(10);
    }
    expect(new Set(scan().unresolved.keys())).toEqual(new Set(Object.keys(STATE_WRITE_UNRESOLVED)));
  }, 120_000);

  it("tier 3 is exactly the listed map and the context constructions are exactly the pinned set", () => {
    expect(scan().tiers.viaCaller).toEqual(Object.keys(LOCK_HELD_VIA_CALLER).sort());
    expect([...scan().constructions].sort()).toEqual([...CONTEXT_CONSTRUCTIONS].sort());
  }, 120_000);

  it("no writer is a get or set accessor, and the lock entry is withSessionLock alone", () => {
    expect(scan().errors.filter((e) => e.startsWith("writer-bearing accessor"))).toEqual([]);
    expect(LOCK_ENTRIES).toEqual(["src/autonomous/session.ts#withSessionLock"]);
  }, 120_000);

  it("the awaited-callback primitive, its delegation chain, the injected slots and the context parameters are the pinned sets", () => {
    expect(AWAITED_CALLBACK_PRIMITIVES).toEqual(["src/core/project-loader.ts#withProjectLock"]);
    expect(scan().chainMembers).toEqual([
      "src/core/project-loader.ts#withLock",
      // A hop of the verified default wrapper for the injected takeover slot.
      "src/core/project-loader.ts#withProjectLock",
      "src/core/project-loader.ts#withProjectLockInternal",
    ]);
    expect(Object.keys(INJECTED_CALLBACK_SLOTS)).toEqual(["src/autonomous/candidate-recovery.ts#CandidateTakeoverDeps.withProjectLock"]);
    expect(CONTEXT_PARAMS).toEqual([
      "src/autonomous/review-identity.ts#prepareReviewRound(host)",
      "src/autonomous/review-identity.ts#writeRoundArtifact(host)",
    ]);
    expect(Object.keys(TEST_SEAM_SLOTS)).toEqual(["src/autonomous/candidate-recovery.ts#CandidateCancelDeps.apply"]);
    expect(UNFOLLOWED_SINK_CHAINS).toEqual({
      "src/cli/register.ts#runCatalogWrite#edge#1": [
        { fn: "src/cli/run.ts#runBoardWrite", param: "fn" },
        { fn: "src/core/board-write-recorder.ts#runWithBoardWriteContext", param: "fn" },
      ],
    });
  }, 120_000);
});
