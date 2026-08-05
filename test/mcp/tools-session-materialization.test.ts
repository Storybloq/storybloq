import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "./tool-schema-helpers.js";
import { initProject } from "../../src/core/init.js";
import { createSession, sessionDir, deleteSessionDir, withSessionLock } from "../../src/autonomous/session.js";
import { deriveWorkspaceId } from "../../src/autonomous/session-types.js";
import { readLastMcpCall, telemetryDirPath } from "../../src/autonomous/liveness.js";
import * as guideModule from "../../src/autonomous/guide.js";

// ISS-945: `handleAutonomousGuide` is wrapped, not replaced -- every test in
// this file except the ordering test relies on ITS REAL not-found/state-
// machine behavior. Only the ordering test overrides it (twice, via
// mockImplementationOnce) to control exactly when each call's guide logic
// "runs" relative to the other, without disturbing any other test's calls.
vi.mock("../../src/autonomous/guide.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/guide.js")>();
  return { ...actual, handleAutonomousGuide: vi.fn(actual.handleAutonomousGuide) };
});

// ISS-945 (F: deletion-during-filing-loop): a single test-file-wide hook, off
// by default (no-op), so `storybloq_review_lenses_synthesize`'s issue-filing
// loop behaves exactly like the real thing for every test except the one
// that deliberately arms this hook to simulate a concurrent session delete
// landing mid-loop.
let onFirstIssueCreate: (() => void) | null = null;
vi.mock("../../src/cli/commands/issue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/commands/issue.js")>();
  return {
    ...actual,
    handleIssueCreate: vi.fn(async (...args: Parameters<typeof actual.handleIssueCreate>) => {
      const hook = onFirstIssueCreate;
      onFirstIssueCreate = null;
      hook?.();
      return actual.handleIssueCreate(...args);
    }),
  };
});

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

function parsedArgs(tool: RegisteredTool, input: Record<string, unknown>): Record<string, unknown> {
  return toolSchema(tool.config.inputSchema).parse(input) as Record<string, unknown>;
}

function emptyLensOutput() {
  return { status: "ok" as const, findings: [], error: null, notes: null };
}

function preExistingFinding(n: number) {
  return {
    id: `eh-${n}`,
    severity: "major",
    category: "unchecked-error",
    file: `source-${n}.ts`,
    line: 1,
    snippet: { quote: `const value${n} = risky();`, startLine: 1 },
    description: `A pre-existing risky call ${n} is unchecked.`,
    suggestion: "Handle the failure.",
    confidence: 0.95,
  };
}

const roots: string[] = [];

afterEach(async () => {
  // `mockImplementationOnce` queues self-drain (only the ordering test uses
  // them, exactly twice, and always awaits both calls to completion), so the
  // mock's persistent default -- the real pass-through set at mock-creation
  // time -- is never disturbed for any other test. Nothing to reset here.
  onFirstIssueCreate = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ISS-945: no session-directory debris for an unknown/deleted id", () => {
  it.each(["resume", "cancel", "pre_compact"] as const)(
    "storybloq_autonomous_guide action=%s with an unknown UUID creates no directory",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), "iss945-guide-"));
      roots.push(root);
      await initProject(root, { name: "iss945" });
      const unknownId = randomUUID();

      const guide = captureTools(root).get("storybloq_autonomous_guide")!;
      const result = await guide.handler(parsedArgs(guide, { sessionId: unknownId, action }));

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(unknownId);
      expect(existsSync(sessionDir(root, unknownId))).toBe(false);
    },
  );

  it("storybloq_autonomous_guide action=report with an unknown UUID creates no directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-guide-report-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const unknownId = randomUUID();

    const guide = captureTools(root).get("storybloq_autonomous_guide")!;
    const result = await guide.handler(parsedArgs(guide, {
      sessionId: unknownId,
      action: "report",
      report: { completedAction: "unknown-session regression probe" },
    }));

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(unknownId);
    expect(existsSync(sessionDir(root, unknownId))).toBe(false);
  });

  it("storybloq_review_lenses_prepare with an unknown UUID creates no directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-prepare-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const unknownId = randomUUID();

    const prepare = captureTools(root).get("storybloq_review_lenses_prepare")!;
    const result = await prepare.handler(parsedArgs(prepare, {
      stage: "CODE_REVIEW",
      diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
      changedFiles: ["x"],
      sessionId: unknownId,
    }));

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(unknownId);
    expect(existsSync(sessionDir(root, unknownId))).toBe(false);
  });

  it("storybloq_review_lenses_synthesize with an unknown UUID and a pre-existing finding creates no directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-synthesize-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const unknownId = randomUUID();

    const synthesize = captureTools(root).get("storybloq_review_lenses_synthesize")!;
    const result = await synthesize.handler(parsedArgs(synthesize, {
      stage: "CODE_REVIEW",
      reviewId: "iss945-unknown",
      reviewRound: 1,
      activeLenses: ["error-handling"],
      skippedLenses: [],
      lensResults: [{ lens: "error-handling", output: { ...emptyLensOutput(), findings: [preExistingFinding(1)] } }],
      diff: "diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new",
      changedFiles: ["changed.ts"],
      sessionId: unknownId,
    }));

    // Would have reached writeFiledPreexisting's mkdir pre-fix: this fixture
    // deliberately produces a pre-existing finding so the filing block (and
    // its mkdir-capable write) is the thing under test, not just the earlier
    // cache-write-back site.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(unknownId);
    expect(existsSync(sessionDir(root, unknownId))).toBe(false);
  });

  it("storybloq_register_subprocess behavior is unchanged for an unknown UUID", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-subprocess-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const unknownId = randomUUID();

    const register = captureTools(root).get("storybloq_register_subprocess")!;
    const result = await register.handler(parsedArgs(register, {
      pid: 12345,
      cmd: "npm test",
      category: "npm-test",
      sessionId: unknownId,
    }));

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Error: session not found or corrupt");
    expect(existsSync(sessionDir(root, unknownId))).toBe(false);
  });

  it("integration: storybloq_session_guard sees zero sessions after unknown-id calls across all gated tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-guard-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const tools = captureTools(root);
    const unknownId = randomUUID();

    await tools.get("storybloq_autonomous_guide")!.handler(parsedArgs(tools.get("storybloq_autonomous_guide")!, {
      sessionId: unknownId,
      action: "report",
      report: { completedAction: "probe" },
    }));
    await tools.get("storybloq_review_lenses_prepare")!.handler(parsedArgs(tools.get("storybloq_review_lenses_prepare")!, {
      stage: "CODE_REVIEW",
      diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
      changedFiles: ["x"],
      sessionId: unknownId,
    }));

    const guardResult = await tools.get("storybloq_session_guard")!.handler(parsedArgs(tools.get("storybloq_session_guard")!, {}));
    const verdict = JSON.parse(guardResult.content[0]!.text);

    expect(verdict.sessions).toHaveLength(0);
    expect(verdict.scanCompleteness).toBe("complete");
    expect(verdict.overallAction).toBe("free");
  });

  it("delete-then-touch: a guide call against a just-deleted session recreates no directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-delete-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const session = createSession(root, "coding", deriveWorkspaceId(root));
    deleteSessionDir(root, session.sessionId);
    expect(existsSync(sessionDir(root, session.sessionId))).toBe(false);

    const guide = captureTools(root).get("storybloq_autonomous_guide")!;
    const result = await guide.handler(parsedArgs(guide, {
      sessionId: session.sessionId,
      action: "report",
      report: { completedAction: "post-delete probe" },
    }));

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(session.sessionId);
    expect(existsSync(sessionDir(root, session.sessionId))).toBe(false);
  });

  it("deletion-during-filing-loop: a session deleted mid-round is not recreated by writeFiledPreexisting", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-mid-loop-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const session = createSession(root, "coding", deriveWorkspaceId(root));

    // Simulates a concurrent `session delete` landing between the two
    // (unlocked) handleIssueCreate calls the filing loop makes for these two
    // findings.
    onFirstIssueCreate = () => deleteSessionDir(root, session.sessionId);

    const synthesize = captureTools(root).get("storybloq_review_lenses_synthesize")!;
    const result = await synthesize.handler(parsedArgs(synthesize, {
      stage: "CODE_REVIEW",
      reviewId: "iss945-mid-loop",
      reviewRound: 1,
      activeLenses: ["error-handling"],
      skippedLenses: [],
      lensResults: [{
        lens: "error-handling",
        output: { ...emptyLensOutput(), findings: [preExistingFinding(1), preExistingFinding(2)] },
      }],
      diff: "diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new",
      changedFiles: ["changed.ts"],
      sessionId: session.sessionId,
    }));
    const output = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBeFalsy();
    // Both findings still filed to the ledger -- unrelated to the session dir.
    expect(output.filedIssues).toHaveLength(2);
    // But the session directory the delete removed was NOT recreated by the
    // final writeFiledPreexisting call.
    expect(existsSync(sessionDir(root, session.sessionId))).toBe(false);
  });
});

describe("ISS-945: positive controls -- a real, live session is unaffected", () => {
  it("guide touch still writes telemetry/lastMcpCall for a real session", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-positive-guide-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const session = createSession(root, "coding", deriveWorkspaceId(root));

    const guide = captureTools(root).get("storybloq_autonomous_guide")!;
    await guide.handler(parsedArgs(guide, {
      sessionId: session.sessionId,
      action: "report",
      report: { completedAction: "positive control probe" },
    }));

    expect(readLastMcpCall(sessionDir(root, session.sessionId))).not.toBeNull();
  });

  it("lens prepare/synthesize still write their session-scoped files for a real session", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-positive-lens-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const session = createSession(root, "coding", deriveWorkspaceId(root));
    const tools = captureTools(root);

    const diff = "diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new";
    const prepare = tools.get("storybloq_review_lenses_prepare")!;
    const prepareResult = await prepare.handler(parsedArgs(prepare, {
      stage: "CODE_REVIEW",
      diff,
      changedFiles: ["changed.ts"],
      sessionId: session.sessionId,
    }));
    expect(prepareResult.isError).toBeFalsy();
    const prepared = JSON.parse(prepareResult.content[0]!.text);
    // Real activation, not a hand-picked lens list: readHarnessMeta (called by
    // synthesize) matches on reviewId, and writeToCache only fires per lens
    // that prepare's own cacheKeys map actually names -- a lens synthesize is
    // not told about here would silently skip its cache write, so reusing
    // prepare's REAL activeLenses/reviewId is what makes this test exercise
    // the changed cache-write-back path rather than falling through it.
    expect(prepared.metadata.activeLenses.length).toBeGreaterThan(0);
    const [firstLens, ...restLenses] = prepared.metadata.activeLenses as string[];

    const synthesize = tools.get("storybloq_review_lenses_synthesize")!;
    const synthesizeResult = await synthesize.handler(parsedArgs(synthesize, {
      stage: "CODE_REVIEW",
      reviewId: prepared.metadata.reviewId,
      reviewRound: 1,
      activeLenses: prepared.metadata.activeLenses,
      skippedLenses: prepared.metadata.skippedLenses,
      lensResults: [
        { lens: firstLens, output: { ...emptyLensOutput(), findings: [preExistingFinding(1)] } },
        ...restLenses.map((lens) => ({ lens, output: emptyLensOutput() })),
      ],
      diff,
      changedFiles: ["changed.ts"],
      sessionId: session.sessionId,
    }));
    const output = JSON.parse(synthesizeResult.content[0]!.text);

    expect(synthesizeResult.isError).toBeFalsy();
    expect(output.filedIssues).toHaveLength(1);

    const dir = sessionDir(root, session.sessionId);
    expect(existsSync(dir)).toBe(true);
    const cacheFiles = await readdir(join(dir, "lens-cache"));
    expect(cacheFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "filed-preexisting.json"))).toBe(true);
  });

  // F1 (byte-review on 42583850): this test can only go RED at parent
  // because it mocks handleAutonomousGuide away, which removes the real
  // per-workspace serialization (guide.ts:944-952's `prev.then(...)` chain,
  // enqueued synchronously with no await before it) that already gave call 2
  // this exact ordering at parent, before this change existed. So this test
  // pins runGuideCallInOrder's OWN ordering contract as exercised through the
  // mock -- it is not evidence that this ordering is new production
  // behavior. The test below pins the ordering property that IS new: why the
  // queue needs to fully settle rather than advance early.
  it("runGuideCallInOrder enqueues calls in order (pins the wrapper's own contract via the mock, not a new production behavior)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss945-order-"));
    roots.push(root);
    await initProject(root, { name: "iss945" });
    const session = createSession(root, "coding", deriveWorkspaceId(root));
    const touchFile = join(telemetryDirPath(sessionDir(root, session.sessionId)), "lastMcpCall");

    const invocationOrder: string[] = [];
    let resolveCall1: (value: unknown) => void;
    const call1Pending = new Promise((resolve) => { resolveCall1 = resolve; });
    let call1Started: () => void;
    const call1StartedPromise = new Promise<void>((resolve) => { call1Started = resolve; });

    vi.mocked(guideModule.handleAutonomousGuide)
      .mockImplementationOnce(async () => {
        invocationOrder.push("call1");
        // call 1's OWN touch already happened before this mock ran (it is
        // inside the same queued task, before handleAutonomousGuide is
        // invoked). Delete it so the next assertion can prove call 2 has not
        // ALSO touched yet.
        rmSync(touchFile, { force: true });
        call1Started();
        return call1Pending;
      })
      .mockImplementationOnce(async () => {
        invocationOrder.push("call2");
        // call 2's OWN touch must already have happened by the time its
        // dispatch (this mock invocation) runs.
        expect(existsSync(touchFile)).toBe(true);
        return { content: [{ type: "text" as const, text: "call2 done" }] };
      });

    const guide = captureTools(root).get("storybloq_autonomous_guide")!;
    const args1 = parsedArgs(guide, { sessionId: session.sessionId, action: "report", report: { completedAction: "probe-1" } });
    const args2 = parsedArgs(guide, { sessionId: session.sessionId, action: "report", report: { completedAction: "probe-2" } });

    const p1 = guide.handler(args1);
    await call1StartedPromise;

    const p2 = guide.handler(args2);
    // Real-clock wait (not just microtask ticks): withSessionLock does actual
    // (fast, uncontended) file I/O, so a queued call 2 needs a real window to
    // prove it does NOT run ahead of call 1's still-pending settlement.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(invocationOrder).toEqual(["call1"]);
    expect(existsSync(touchFile)).toBe(false);

    resolveCall1!({ content: [{ type: "text" as const, text: "call1 done" }] });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(invocationOrder).toEqual(["call1", "call2"]);
    expect((r1 as { content: Array<{ text: string }> }).content[0]!.text).toBe("call1 done");
    expect((r2 as { content: Array<{ text: string }> }).content[0]!.text).toBe("call2 done");
  });

  // F2 (byte-review on 42583850, the required fixup): the queue's real
  // justification is that handleAutonomousGuide holds withSessionLock for
  // its whole inner call (guide.ts:947), so an early-advancing queue would
  // let a queued call's touch contend for that same lock -- and
  // withSessionLock gives up after 3 retries (~1.5s) and throws, silently
  // dropped by the gate's `catch { /* best-effort */ }`. This test pins that
  // a queued call's touch happens only after its predecessor releases the
  // real session lock, so it never attempts that lock while contended and is
  // never dropped this way. Unlike the test above, call 1's mock acquires
  // the REAL withSessionLock (not a bare stub) so the contention it guards
  // against is genuine, mirroring handleGuideInner's actual shape rather
  // than mocking the serialization away.
  it(
    "a queued call's touch happens only after its predecessor releases the real session lock, so it never contends for it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "iss945-order-lock-"));
      roots.push(root);
      await initProject(root, { name: "iss945" });
      const session = createSession(root, "coding", deriveWorkspaceId(root));
      const touchFile = join(telemetryDirPath(sessionDir(root, session.sessionId)), "lastMcpCall");

      let releaseCall1Lock: () => void;
      const call1LockHeld = new Promise<void>((resolve) => { releaseCall1Lock = resolve; });
      let call1LockAcquired: () => void;
      const call1LockAcquiredPromise = new Promise<void>((resolve) => { call1LockAcquired = resolve; });

      vi.mocked(guideModule.handleAutonomousGuide)
        .mockImplementationOnce(async () => {
          // call 1's OWN touch (the queued task's gate step, run just before
          // this mock) already succeeded uncontended. Clear it so the
          // assertions below can only be satisfied by call 2's touch.
          rmSync(touchFile, { force: true });
          return withSessionLock(root, async () => {
            call1LockAcquired();
            await call1LockHeld;
            return { content: [{ type: "text" as const, text: "call1 done" }] };
          });
        })
        .mockImplementationOnce(async () => ({ content: [{ type: "text" as const, text: "call2 done" }] }));

      const guide = captureTools(root).get("storybloq_autonomous_guide")!;
      const args1 = parsedArgs(guide, { sessionId: session.sessionId, action: "report", report: { completedAction: "f2-probe-1" } });
      const args2 = parsedArgs(guide, { sessionId: session.sessionId, action: "report", report: { completedAction: "f2-probe-2" } });

      const p1 = guide.handler(args1);
      await call1LockAcquiredPromise;

      const p2 = guide.handler(args2);

      try {
        // Held well past withSessionLock's own retry-exhaustion window so a
        // call 2 that wrongly attempted the real lock while call 1 held it
        // would already have exhausted its retries and silently given up by
        // now -- a discriminating wait, not a cosmetic one.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(existsSync(touchFile)).toBe(false);
      } finally {
        // Always release, even if the assertion above throws -- otherwise a
        // failing run leaves the real session lock held past this test,
        // wedging every test that follows it.
        releaseCall1Lock!();
      }

      await Promise.all([p1, p2]);
      expect(existsSync(touchFile)).toBe(true);
    },
    10000,
  );
});
