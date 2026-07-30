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

/**
 * A snake_case identifier as it appears in the RENDERED report.
 *
 * `formatSessionReport` has two formats, `json` and `md`, so every non-JSON
 * byte it produces is Markdown -- and `storybloq_session_report` hands exactly
 * that text to an MCP client. Underscores are therefore escaped, and asserting
 * the bare identifier is asserting the document is unescaped: the same property
 * that let a session-supplied ticket title put a link into the one document an
 * operator reads during an incident.
 *
 * The backslashes are visible to someone reading the report in a terminal.
 * That is the accepted cost, and it is the cheaper of the two: an escape
 * artifact is self-evident and reads correctly anyway, while an injected link
 * is invisible precisely when it matters.
 */
function escapedCode(code: string): string {
  return code.replace(/_/g, "\\_");
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
    // ISS-897: phrased on what was ESTABLISHED. The old "state.json missing"
    // came from an `existsSync` precheck that a dangling parent symlink also
    // satisfied, so the command asserted a fact about a path it could not
    // reach. All three surfaces now say the same establishable thing.
    expect(result.output).toContain("an entry exists at that path, but no readable state.json is in it");
  });

  it("returns corrupt error for invalid state.json", async () => {
    const dir = makeSessionDir(testRoot);
    writeFileSync(join(dir, "state.json"), "not json");
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("corrupt");
  });

  it("returns version mismatch for a NEWER schema version, framed as an upgrade", async () => {
    const dir = makeSessionDir(testRoot);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 999 }));
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("version_mismatch");
    expect(result.output).toContain("session schema v999");
    // ISS-897/ISS-902: a newer writer is not damage, so this surface must not
    // read as corruption or suggest removing it. It must not read as a clean
    // bill of health either -- this very fixture is `{ schemaVersion: 999 }`
    // and nothing else, so the fence returned before a single session field was
    // validated. "Intact" would be a claim about session fields this build never validated or interpreted, and so
    // would "is NOT lost" -- that one promises a compatible reader would still
    // get the session back.
    expect(result.output).not.toContain("is NOT lost");
    expect(result.output).toContain("Do NOT delete it");
    expect(result.output).toContain(
      "nothing here establishes that it is damaged OR that it is sound",
    );
    expect(result.output).not.toContain("corrupt");
    expect(result.output).not.toMatch(/is intact/);
  });

  it("reports a LOWER schema version as UNSUPPORTED, not as corruption", async () => {
    // This test used to require the opposite, and that requirement was the bug.
    // The scanner treats a present-but-unsupported version as a record it can
    // still SEE but must not act on -- admitted, reported, "do not delete it".
    // Routing the same file to `project_corrupt` here made two operator surfaces
    // disagree about one state.json, and the disagreement was destructive in
    // exactly one direction: an operator following this command's advice would
    // delete a session the guard had just refused to call damaged.
    //
    // The remedy is shaped like the newer-writer one because the situation is
    // the same: this build cannot interpret the file, and therefore knows
    // nothing about its condition -- which forbids deleting it and equally
    // forbids vouching for it. It is not IDENTICAL, though: upgrading fixes a
    // newer writer and does nothing for an older or malformed version, so this
    // branch says "a storybloq that supports that schema" instead.
    //
    // Note also what the SCANNER does with this exact fixture. It carries only
    // a `schemaVersion`, so its absent status reads as non-active, and the
    // unsupported-version pre-gate reports it as `unadmitted-schema-version-
    // undetermined` rather than admitting it. Admission here is `session
    // report` resolving a named session, which is a different path.
    const dir = makeSessionDir(testRoot);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 0 }));
    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("version_mismatch");
    expect(result.output).toContain("schemaVersion");
    expect(result.output).toContain(
      "nothing here establishes that it is damaged OR that it is sound",
    );
    expect(result.output).toContain("Do NOT delete it");
    expect(result.output).not.toContain("corrupt");
    expect(result.output).not.toContain("is NOT lost");
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

  /**
   * Event data is arbitrary and comes off disk (ISS-897).
   *
   * The timeline rendered it with a bare `JSON.stringify`, which recurses --
   * so a value nested deeper than the encoder can go raised inside the
   * formatter and killed the whole report. `events.log` is written by this
   * build, but the report is exactly the tool an operator reaches for when
   * something has gone wrong with a session's files, and a diagnostic that
   * dies on the file it is diagnosing has told them nothing.
   */
  it("survives an event whose data cannot be serialized, and bounds a huge one", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir);
    // Written as raw text: this is a value `JSON.stringify` cannot emit, so
    // `writeEvents` (which stringifies) could not produce the fixture.
    const deep = `${"[".repeat(20000)}1${"]".repeat(20000)}`;
    expect(() => JSON.stringify(JSON.parse(deep) as unknown)).toThrow();
    writeFileSync(
      join(dir, "events.log"),
      `{"rev":1,"type":"deep","timestamp":"2026-03-27T10:00:00Z","data":{"v":${deep}}}\n` +
        `{"rev":2,"type":"flood","timestamp":"2026-03-27T10:01:00Z","data":{"v":${JSON.stringify("y".repeat(50_000))}}}\n`,
    );

    const result = await handleSessionReport(SESSION_ID, testRoot);
    // It did not die, and it says which value it could not render rather than
    // dropping the event.
    expect(result.output).toContain("[deep]");
    expect(result.output).toContain("unserializable");
    // ...and the flood is cut, with the magnitude reported.
    expect(result.output).toContain("[flood]");
    expect(result.output).not.toContain("y".repeat(500));
    expect(result.output).toMatch(/truncated from \d+ characters/);
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

  it("does not call a normal FINALIZE transition landable and uncommitted", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      status: "active",
      state: "FINALIZE",
      ticket: { id: "T-010", displayId: "T-010", title: "Normal finalize", risk: "low", claimed: true },
      reviews: {
        plan: [],
        code: [{
          round: 1,
          reviewer: "agent",
          verdict: "approve",
          findingCount: 0,
          criticalCount: 0,
          unresolvedCriticalCount: 0,
          majorCount: 0,
          suggestionCount: 0,
          timestamp: new Date().toISOString(),
        }],
      },
    });

    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).not.toContain("landable_uncommitted");
  });

  it("does not infer current-ticket scope expansion from prior session deferrals", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      status: "active",
      state: "IMPLEMENT",
      ticket: { id: "T-011", displayId: "T-011", title: "Small follow-up", risk: "low", claimed: true },
      filedDeferrals: Array.from({ length: 6 }, (_, index) => ({
        fingerprint: `prior-${index}`,
        issueId: `ISS-0${index + 1}`,
      })),
      reviews: {
        plan: [],
        code: [{
          round: 1,
          reviewer: "agent",
          verdict: "revise",
          findingCount: 1,
          criticalCount: 0,
          majorCount: 1,
          suggestionCount: 0,
          timestamp: new Date().toISOString(),
        }],
      },
    });

    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).not.toContain("scope_expanded");
  });

  it("reports code-review non-convergence in Problems", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      status: "active",
      state: "IMPLEMENT",
      ticket: { id: "T-044", displayId: "T-044", title: "Durability fix", risk: "low", claimed: true },
      ticketStartedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      reviews: {
        plan: [],
        code: Array.from({ length: 12 }, (_, idx) => ({
          round: idx + 1,
          reviewer: "agent",
          verdict: "revise",
          findingCount: 3,
          criticalCount: 0,
          majorCount: 2,
          suggestionCount: 0,
          timestamp: new Date().toISOString(),
        })),
      },
    });
    writeEvents(dir, Array.from({ length: 12 }, (_, idx) => ({
      rev: idx + 1,
      type: "transition",
      timestamp: "2026-07-09T10:00:00Z",
      data: { from: "CODE_REVIEW", to: "IMPLEMENT", action: "back" },
    })));

    const result = await handleSessionReport(SESSION_ID, testRoot);

    expect(result.output).toContain(escapedCode("code_review_non_converging"));
    expect(result.output).toContain(escapedCode("landable_uncommitted"));
  });

  it("treats addressed critical findings as non-blocking at the landing cap", async () => {
    const dir = makeSessionDir(testRoot);
    writeState(dir, {
      status: "active",
      state: "FINALIZE",
      ticket: { id: "T-044", displayId: "T-044", title: "Durability fix", risk: "low", claimed: true },
      ticketStartedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      reviews: {
        plan: [],
        code: Array.from({ length: 12 }, (_, idx) => ({
          round: idx + 1,
          reviewer: "agent",
          verdict: "revise",
          findingCount: 1,
          criticalCount: 1,
          unresolvedCriticalCount: 0,
          majorCount: 0,
          suggestionCount: 0,
          timestamp: new Date().toISOString(),
        })),
      },
      landingDecision: {
        stage: "CODE_REVIEW",
        round: 12,
        maxReviewRounds: 12,
        reason: "max_review_rounds_no_blocking",
        findingCounts: { critical: 1, major: 0, minor: 0, suggestion: 0 },
        timestamp: new Date().toISOString(),
      },
    });

    const result = await handleSessionReport(SESSION_ID, testRoot);
    expect(result.output).toContain("1 critical, 0 unresolved critical");
    expect(result.output).toContain(escapedCode("landable_uncommitted"));
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
