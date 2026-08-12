import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { acknowledgeBusMessage, sendBusMessage } from "../../../src/bus/index.js";
import { createBusFixture, createIssue, type BusFixture } from "../../bus/helpers.js";

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

function recipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: {
      maxTicketsPerSession: 1,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
  };
}

function state(): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000420",
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null, expectedHead: null },
    lease: { workspaceId: "bus-finalize", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 1, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 1,
    config: { maxTicketsPerSession: 1, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
  } as FullSessionState;
}

describe("FINALIZE Storybloq Bus gate", () => {
  it("does not block a fresh checkout whose gitignored Bus runtime is absent", async () => {
    const fixture = await createBusFixture("finalize-bus-fresh-checkout");
    fixtures.push(fixture);
    await rm(join(fixture.root, ".story", "bus"), { recursive: true });
    // T-428: a genuinely fresh checkout (bus enabled in committed config, never set
    // up here) has neither a runtime NOR deletion-evidence -- evidence is gitignored,
    // so a clone never receives it. Removing both models that L-031 fresh state.
    // Deleting an EVIDENCED runtime is `runtime_lost` (covered by the partial-runtime
    // case below and deletion-evidence.test.ts), which correctly blocks finalize.
    await rm(join(fixture.root, ".story", ".bus-evidence.json"), { force: true });
    const sessionDir = join(fixture.root, ".story", "sessions", state().sessionId);
    await mkdir(sessionDir, { recursive: true });

    const result = await new FinalizeStage().enter(
      new StageContext(fixture.root, sessionDir, state(), recipe()),
    );

    expect((result as { instruction: string }).instruction).toContain("# Finalize");
    expect((result as { instruction: string }).instruction).not.toContain("blocked by Storybloq Bus");
    await expect(access(join(fixture.root, ".story", "bus")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  /**
   * T-461 phase 4: FINALIZE is the last point before the work becomes a commit,
   * so a level below standard is stated in the prose rather than left in a
   * session file nobody opens. `off` gets its own sentence because it is a
   * different claim: not "reviewed less" but "no review verdict exists for this
   * commit", which is what someone reading the history later needs.
   */
  it("states a below-standard level in the finalize prose", async () => {
    const fixture = await createBusFixture("finalize-effort-prose");
    fixtures.push(fixture);
    await rm(join(fixture.root, ".story", "bus"), { recursive: true });
    await rm(join(fixture.root, ".story", ".bus-evidence.json"), { force: true });
    const sessionDir = join(fixture.root, ".story", "sessions", state().sessionId);
    await mkdir(sessionDir, { recursive: true });

    const enter = async (overrides: Partial<FullSessionState>) => {
      const result = await new FinalizeStage().enter(
        new StageContext(fixture.root, sessionDir, { ...state(), ...overrides } as FullSessionState, recipe()),
      );
      return (result as { instruction: string }).instruction;
    };

    expect(await enter({ currentReviewEffort: "light", currentReviewEffortSource: "size-mapped" } as Partial<FullSessionState>))
      .toContain("Review effort: light (size-mapped). This item was reviewed at a lower depth than the project default.");

    const off = await enter({ currentReviewEffort: "off", currentReviewEffortSource: "item" } as Partial<FullSessionState>);
    expect(off).toContain("Review effort: off (item). Review stages were skipped for this item; no review verdict exists for this commit.");
    // An off item has no verdict to have passed. Saying it passed beside the
    // sentence saying no verdict exists would hand the reader two
    // contradictory claims at the commit boundary.
    expect(off).toContain("Review stages were skipped. Time to commit.");
    expect(off).not.toContain("Code review passed");

    // standard says nothing, so the instruction is what it was before the dial.
    const standard = await enter({});
    expect(standard).not.toContain("Review effort:");
    expect(standard).toContain("Code review passed. Time to commit.");
    expect(standard).toContain("# Finalize");
  });

  it("blocks a partially present Bus runtime without recreating it", async () => {
    const fixture = await createBusFixture("finalize-bus-partial-runtime");
    fixtures.push(fixture);
    const pending = join(fixture.root, ".story", "bus", "mailboxes", fixture.a.endpointId, "pending");
    await rm(pending, { recursive: true });
    const sessionDir = join(fixture.root, ".story", "sessions", state().sessionId);
    await mkdir(sessionDir, { recursive: true });

    const result = await new FinalizeStage().enter(
      new StageContext(fixture.root, sessionDir, state(), recipe()),
    );

    expect((result as { instruction: string }).instruction).toContain("Finalize blocked by Storybloq Bus");
    expect((result as { instruction: string }).instruction).toContain("storybloq bus doctor");
    await expect(access(pending)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks an unacknowledged critical notice before staging", async () => {
    const fixture = await createBusFixture("finalize-bus");
    fixtures.push(fixture);
    const issueId = await createIssue(fixture.root, "critical");
    const sent = await sendBusMessage(fixture.root, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "critical",
      body: "Critical review finding requires acknowledgment.",
      refs: { issue: issueId },
      idempotencyKey: "finalize-critical-notice",
    });
    const sessionDir = join(fixture.root, ".story", "sessions", state().sessionId);
    await mkdir(sessionDir, { recursive: true });
    const stage = new FinalizeStage();
    const blocked = await stage.enter(new StageContext(fixture.root, sessionDir, state(), recipe()));
    expect(blocked).toHaveProperty("instruction");
    expect((blocked as { instruction: string }).instruction).toContain("Finalize blocked by Storybloq Bus");

    await acknowledgeBusMessage(fixture.root, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    const clear = await stage.enter(new StageContext(fixture.root, sessionDir, state(), recipe()));
    expect((clear as { instruction: string }).instruction).toContain("# Finalize");
    expect((clear as { instruction: string }).instruction).not.toContain("blocked by Storybloq Bus");
  });
});
