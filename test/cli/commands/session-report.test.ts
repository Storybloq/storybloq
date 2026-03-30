import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSessionReport } from "../../../src/cli/commands/session-report.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";

function makeSessionDir(root: string): string {
  const dir = join(root, ".story", "sessions", SESSION_ID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(dir: string, overrides: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "SESSION_END",
    revision: 10,
    status: "completed",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", initHead: "abc123", expectedHead: "def456" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 5, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 200 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: "normal",
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: new Date(Date.now() - 600000).toISOString(), // 10 min ago
    guideCallCount: 5,
    config: { maxTicketsPerSession: 3, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

function writeEvents(dir: string, events: Array<Record<string, unknown>>): void {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "events.log"), lines);
}

describe("handleSessionReport", () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "session-report-"));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  // --- Error cases ---

  it("rejects invalid session ID format", async () => {
    const result = await handleSessionReport("not-a-uuid", testRoot);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid session ID");
  });

  it("returns not_found for nonexistent session", async () => {
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("returns corrupt error for missing state.json", async () => {
    makeSessionDir(testRoot); // dir exists, no state.json
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("state.json missing");
  });

  it("returns corrupt error for invalid state.json", async () => {
    const dir = makeSessionDir(testRoot);
    writeFileSync(join(dir, "state.json"), "not json");
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("corrupt");
  });

  it("returns version mismatch for wrong schema version", async () => {
    const dir = makeSessionDir(testRoot);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 999 }));
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("schema version");
  });

  // --- Successful report ---

  it("generates report with all 7 section headings", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("## Session Summary");
    expect(result.output).toContain("## Ticket Progression");
    expect(result.output).toContain("## Review Stats");
    expect(result.output).toContain("## Event Timeline");
    expect(result.output).toContain("## Context Pressure");
    expect(result.output).toContain("## Git Summary");
    expect(result.output).toContain("## Problems");
  });

  it("includes completed tickets in progression", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      completedTickets: [
        { id: "T-001", title: "First ticket", risk: "low", realizedRisk: "medium", commitHash: "aaa111" },
        { id: "T-002", title: "Second ticket", risk: "medium", commitHash: "bbb222" },
      ],
    });
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("T-001");
    expect(result.output).toContain("T-002");
    expect(result.output).toContain("aaa111");
    expect(result.output).toContain("low → medium"); // realizedRisk escalation
  });

  it("shows in-progress ticket when no completions", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      status: "active",
      state: "IMPLEMENT",
      ticket: { id: "T-005", title: "Current work", risk: "high", claimed: true },
    });
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("T-005");
    expect(result.output).toContain("In progress");
  });

  it("includes review stats", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "approve", findingCount: 2, criticalCount: 0, majorCount: 1, suggestionCount: 1, timestamp: new Date().toISOString() }],
        code: [{ round: 1, reviewer: "agent", verdict: "request_changes", findingCount: 3, criticalCount: 1, majorCount: 1, suggestionCount: 1, timestamp: new Date().toISOString() }],
      },
    });
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("Plan reviews");
    expect(result.output).toContain("Code reviews");
    expect(result.output).toContain("Total findings");
  });

  // --- Events ---

  it("parses and includes events in timeline", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    writeEvents(dir, [
      { rev: 1, type: "start", timestamp: "2026-03-27T10:00:00Z", data: { recipe: "coding" } },
      { rev: 2, type: "transition", timestamp: "2026-03-27T10:01:00Z", data: { from: "INIT", to: "PICK_TICKET" } },
    ]);
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("[start]");
    expect(result.output).toContain("[transition]");
  });

  it("skips malformed events and reports count", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    writeFileSync(join(dir, "events.log"), '{"rev":1,"type":"start","timestamp":"2026-03-27T10:00:00Z","data":{}}\nnot json\n{"broken": true}\n');
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("malformed");
  });

  it("handles missing events.log gracefully", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    // No events.log written
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("Not available");
    expect(result.isError).toBeUndefined();
  });

  // --- Problems ---

  it("reports abnormal termination in Problems", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, { terminationReason: "cancelled" });
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("Abnormal termination");
  });

  it("reports no problems for clean session", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("None detected");
  });

  // --- JSON format ---

  it("returns structured JSON when format is json", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    const result = await handleSessionReport(SESSION_ID, testRoot, "json");
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.summary.sessionId).toBe(SESSION_ID);
    expect(parsed.data.summary.mode).toBe("auto");
    expect(parsed.data.contextPressure.level).toBe("low");
  });
});
