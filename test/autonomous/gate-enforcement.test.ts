/**
 * T-474: `resolveOrReadFrozenGateStatus` never fails open. A legacy session
 * (`frozenGate` undefined, predating this field) whose `ctx.loadProject()`
 * fails must resolve to a blocking `unresolved` hold naming the failure,
 * never to `ungated` -- binding scope item 4, "enforcement never fails
 * open," unqualified.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { resolveOrReadFrozenGateStatus, resolveGateStatus } from "../../src/autonomous/stages/gate-enforcement.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import type { TicketRefResolver } from "../../src/core/arrangement-bounds.js";
import { loadArrangementsSafe } from "../../src/core/arrangement-loader.js";
import { isArrangementConflicted } from "../../src/core/arrangement-authority.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000474",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    // frozenGate deliberately omitted -- this is the legacy (pre-field) shape.
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("resolveOrReadFrozenGateStatus (T-474 never-fails-open)", () => {
  let testRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    // A bare tmpdir with no `.story/config.json` at all -- `ctx.loadProject()`
    // throws, simulating a project that cannot load (I/O error, half-written
    // config, disk pressure) at exactly the enforcement moment.
    testRoot = mkdtempSync(join(tmpdir(), "gate-enforcement-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("resolves to unresolved, never ungated, when a legacy session's project fails to load", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const resolved = await resolveOrReadFrozenGateStatus(ctx);

    expect(resolved.status).toBe("unresolved");
    if (resolved.status === "unresolved") {
      expect(resolved.reason).toContain("project load failed");
    }
    expect(resolved.status).not.toBe("ungated");
  });

  it("caches the unresolved result on ctx.state so a second call doesn't re-scan", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const first = await resolveOrReadFrozenGateStatus(ctx);
    expect(ctx.state.frozenGate).toEqual(first);

    const second = await resolveOrReadFrozenGateStatus(ctx);
    expect(second).toEqual(first);
  });
});

describe("T-478: resolveGateStatus fails closed on a conflicted arrangement, regardless of lifecycle ordering", () => {
  let testRoot: string;
  const canonicalTicketId = "t-aaa0000000000001";

  const resolver: TicketRefResolver = {
    resolveTicketRef: (ref: string) =>
      ref === "T-001"
        ? { kind: "found", item: { id: canonicalTicketId } as never }
        : { kind: "missing" as const },
  };

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "gate-enforcement-conflict-"));
    mkdirSync(join(testRoot, ".story", "arrangements"), { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  function writeArrangement(id: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(
      join(testRoot, ".story", "arrangements", `${id}.json`),
      JSON.stringify({
        id,
        lifecycle: "active",
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "pen-session" },
          { role: "worker", client: "claude", identityAnchor: "worker-session" },
        ],
        gates: [],
        unreachability: { onIrreversibleWork: "hold" },
        createdDate: "2026-08-27",
        updatedAt: "2026-08-27T00:00:00.000Z",
        ...overrides,
      }),
    );
  }

  it("a conflicted arrangement resolves unresolved even when its retained lifecycle reads 'closed' -- the exact ordering regression flagged in round 2", () => {
    // If the lifecycle skip ran BEFORE the conflict check, this arrangement
    // would be silently skipped (lifecycle !== "active") and the ticket
    // would resolve "ungated" instead of "unresolved" -- exactly the failure
    // this test exists to catch.
    writeArrangement("a-0123456789abcdef", {
      lifecycle: "closed",
      _conflicts: [{ fieldPath: "lifecycle", kind: "field", base: "active", ours: "suspended", theirs: "closed" }],
    });

    // codex round-1 finding: `resolveGateStatus`'s "unresolved" result is ALSO
    // what a rejected/unloadable scan produces -- assert the fixture actually
    // loads clean and IS classified conflicted, so this test provably
    // exercises the ordering check itself, not a loader-warning wrong path.
    const scan = loadArrangementsSafe(testRoot);
    expect(scan.warnings).toEqual([]);
    expect(scan.arrangements).toHaveLength(1);
    expect(isArrangementConflicted(scan.arrangements[0]!)).toBe(true);

    const result = resolveGateStatus(testRoot, canonicalTicketId, resolver);

    expect(result.status).toBe("unresolved");
    expect(result.status).not.toBe("ungated");
  });

  it("an unconflicted, active, covering arrangement still resolves gated as before (no false-positive from the new check)", () => {
    writeArrangement("a-fedcba9876543210", { gates: [{ name: "plan-ack", ackRole: "pen" }] });

    const result = resolveGateStatus(testRoot, canonicalTicketId, resolver);

    expect(result.status).toBe("gated");
    if (result.status === "gated") {
      expect(result.arrangementId).toBe("a-fedcba9876543210");
    }
  });
});
