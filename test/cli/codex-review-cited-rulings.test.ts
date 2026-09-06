/**
 * T-494: the NATIVE codex review route must deliver cited rulings too.
 *
 * This is the third of three packet call sites, and the one with no stage
 * harness. It is tested by driving the REAL `handleCodexReview` and asserting
 * on the prompt file the reviewer is actually given, with only the `codex`
 * subprocess replaced. The prompt is written to disk before the subprocess is
 * spawned, so the artifact is complete and real even though the spawn fails.
 *
 * Identical wiring to the other two sites is not evidence that this one works.
 * T-489 shipped a whole tier with zero call sites behind a green suite; the
 * distinguishing test is the point.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const spawnCalls: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // `commandExists("codex")` runs this. Report success so the command gets
    // past its PATH gate and reaches the packet build.
    execFileSync: (cmd: string, ...rest: unknown[]) => {
      if (cmd === "codex") return Buffer.from("codex 1.0.0");
      return (actual.execFileSync as (...a: unknown[]) => unknown)(cmd, ...rest);
    },
    spawn: (cmd: string) => {
      spawnCalls.push(cmd);
      throw new Error("codex subprocess deliberately not run in this test");
    },
  };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { initProject } = await import("../../src/core/init.js");
const { handleTicketCreate } = await import("../../src/cli/commands/ticket.js");
const { handleRulingCreate } = await import("../../src/cli/commands/ruling.js");
const { handleCodexReview } = await import("../../src/cli/commands/codex-review.js");

const RULING_TEXT = "The pen rules: rulings reach agents by citation, not by paste.";
const SESSION_ID = "00000000-0000-0000-0000-000000000494";

const tempDirs: string[] = [];
const origCwd = process.cwd();
afterEach(() => {
  process.chdir(origCwd);
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  spawnCalls.length = 0;
});

describe("native codex review delivers cited rulings in its prompt", () => {
  it("writes the cited ruling into the prompt file the reviewer is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "t494-native-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Cited ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const created = await handleRulingCreate(
      {
        text: RULING_TEXT,
        attribution: "owner-direct",
        date: "2026-09-06",
        scopeTags: [],
        cites: ["T-001"],
        clientTaskId: "test-session-native",
      },
      "json",
      root,
    );
    const rulingId = JSON.parse(created.output).data.id as string;

    const sessionDir = join(root, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "plan.md"), "# The plan\n\nDo the thing.\n");
    const now = new Date().toISOString();
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: SESSION_ID,
        recipe: "coding",
        state: "PLAN_REVIEW",
        revision: 1,
        status: "active",
        reviews: { plan: [], code: [] },
        completedTickets: [],
        finalizeCheckpoint: null,
        git: { branch: "main", mergeBase: "HEAD", expectedHead: "HEAD" },
        lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
        contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
        pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
        compactPending: false, compactPreparedAt: null, resumeBlocked: false,
        terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
        config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
        ticket: { id: "T-001", title: "Cited ticket", claimed: true, risk: "low" },
        filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
      }),
    );

    process.chdir(root);
    // The spawn stub throws, which is the intended end of this run: everything
    // this test asserts is already on disk by then.
    await expect(
      handleCodexReview({ sessionId: SESSION_ID, kind: "plan", format: "guide-report" } as never),
    ).rejects.toThrow("deliberately not run");
    expect(spawnCalls).toEqual(["codex"]);

    // The prompt is written before the subprocess is spawned, so it is the
    // complete artifact the reviewer would have read.
    const prompt = readFileSync(join(sessionDir, "review", "plan-prompt.txt"), "utf-8");
    expect(prompt).toContain("## Cited Rulings");
    expect(prompt).toContain(rulingId);
    expect(prompt).toContain(RULING_TEXT);
  });
});
