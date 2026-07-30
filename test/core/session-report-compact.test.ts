/**
 * T-185: Compact session report tests.
 */
import { describe, it, expect } from "vitest";
import { formatCompactReport, type CompactReportData } from "../../src/core/session-report-formatter.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "SESSION_END", revision: 1, status: "completed",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: "normal", waitingForRetry: false, lastGuideCall: now,
    startedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    guideCallCount: 20,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [],
    ...overrides,
  } as FullSessionState;
}

describe("formatCompactReport", () => {
  it("produces duration, ticket count, issue count, review stats", () => {
    const state = makeState({
      completedTickets: [
        { id: "T-001", title: "First", commitHash: "aaa" },
        { id: "T-002", title: "Second", commitHash: "bbb" },
      ],
      resolvedIssues: ["ISS-001"],
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "approve", findingCount: 3, criticalCount: 0, majorCount: 1, suggestionCount: 2, timestamp: new Date().toISOString() }],
        code: [{ round: 1, reviewer: "agent", verdict: "approve", findingCount: 5, criticalCount: 1, majorCount: 2, suggestionCount: 2, timestamp: new Date().toISOString() }],
      },
      contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 2, compactionCount: 3, eventsLogBytes: 0 },
    });

    const report = formatCompactReport({ state });
    expect(report).toContain("## Session Report");
    expect(report).toContain("**Tickets:** 2");
    expect(report).toContain("**Issues:** 1");
    expect(report).toContain("**Reviews:** 2 rounds (8 findings)");
    expect(report).toContain("**Compactions:** 3");
    expect(report).toContain("T-001");
    expect(report).toContain("T-002");
  });

  it("includes per-ticket timing when available (T-187)", () => {
    const state = makeState({
      completedTickets: [
        { id: "T-001", title: "Timed", commitHash: "aaa",
          startedAt: "2026-04-04T10:00:00.000Z",
          completedAt: "2026-04-04T10:30:00.000Z" },
      ],
    });

    const report = formatCompactReport({ state });
    expect(report).toContain("30m");
    expect(report).toContain("**Avg time per ticket:** 30m");
  });

  it("shows What's Left when remainingWork provided", () => {
    const state = makeState();
    const data: CompactReportData = {
      state,
      remainingWork: {
        tickets: [{ id: "T-010", title: "Next task" }],
        issues: [{ id: "ISS-005", title: "Bug fix", severity: "high" }],
      },
    };

    const report = formatCompactReport(data);
    expect(report).toContain("### What's Left");
    expect(report).toContain("T-010: Next task");
    expect(report).toContain("ISS-005: Bug fix (high)");
  });

  it("handles empty session (0 tickets, 0 issues)", () => {
    const state = makeState();
    const report = formatCompactReport({ state });
    expect(report).toContain("## Session Report");
    expect(report).toContain("**Tickets:** 0");
    expect(report).toContain("**Issues:** 0");
    expect(report).not.toContain("### Completed");
    expect(report).not.toContain("### What's Left");
  });

  it("uses endedAt for duration when provided", () => {
    const start = "2026-04-04T10:00:00.000Z";
    const end = "2026-04-04T12:15:00.000Z";
    const state = makeState({ startedAt: start, lastGuideCall: start });

    const report = formatCompactReport({ state, endedAt: end });
    expect(report).toContain("2h 15m");
  });

  it("handles tickets without timing data gracefully", () => {
    const state = makeState({
      completedTickets: [
        { id: "T-001", title: "No timing", commitHash: "aaa" },
      ],
    });

    const report = formatCompactReport({ state });
    expect(report).toContain("T-001");
    expect(report).toContain("--"); // no duration
    expect(report).not.toContain("**Avg time per ticket:**");
  });
});

/**
 * Split a rendered row the way a Markdown renderer does.
 *
 * Counting LINES cannot see this bug: an escaped-wrongly pipe forges a column,
 * not a line, so a test that counts rows passes over a row that has silently
 * grown two extra cells. A `|` is structural unless the backslash immediately
 * before it is itself unescaped, which is why the scan consumes escape PAIRS.
 */
function markdownCells(row: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === "\\" && i + 1 < row.length) {
      buf += ch + row[i + 1];
      i += 1;
      continue;
    }
    if (ch === "|") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  // Drop the empties either side of the row's outer pipes.
  return out.slice(1, -1);
}

function ticketRow(report: string): string {
  const rows = report.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
  expect(rows).toHaveLength(2);
  return rows[1]!;
}

describe("a completed ticket cannot forge a row in the handover (ISS-897)", () => {
  // This table is written into a HANDOVER, which is the record the next session
  // reads as what happened. Its cells come out of `state.json`, where the title
  // is an unconstrained string -- so the pipe escape that was already here was
  // solving only the narrowest third of the problem: `|` shifts a value into
  // the wrong column, a newline invents a whole row, and an ESC redraws one.
  const ESC = "\u001b";

  it.each([1, 2, 3])(
    "keeps the title in ONE cell with %s backslash(es) before a pipe",
    (n) => {
      // Escaping the pipe alone was not enough. Markdown backslash escapes pair
      // left to right, so a title containing `\\|` renders as `\\\\|` and the
      // renderer reads the first backslash as escaping the SECOND -- the pipe
      // stays structural and the value forges two columns, from a payload that
      // merely had to carry one extra character. Odd and even counts both have
      // to hold, or a payload just adds a backslash until the parity favours it.
      const report = formatCompactReport({
        state: makeState({
          completedTickets: [
            {
              id: `T-00${n}`,
              title: `Real${"\\".repeat(n)}| 5m | T-999 | Forged | 0m |`,
              commitHash: "aaa",
            },
          ],
        }),
      });

      const cells = markdownCells(ticketRow(report));
      expect(cells, `${n} backslash(es) forged a column`).toHaveLength(3);
      expect(cells[1]).toContain("T-999");
    },
  );

  it("escapes a backslash before a pipe in the ID column too", () => {
    // The ID is no more constrained than the title: both are strings read back
    // out of `state.json`, and forging a column needs only one cell to leak.
    const report = formatCompactReport({
      state: makeState({
        completedTickets: [{ id: `T-1\\| x | y |`, title: "ok", commitHash: "aaa" }],
      }),
    });
    const cells = markdownCells(ticketRow(report));
    expect(cells).toHaveLength(3);
    // Three cells is also what DROPPING the id produces, so the payload has to
    // be shown to have survived into the first cell -- escaped, not discarded.
    expect(cells[0], "the ID was dropped rather than escaped").toContain("T-1");
    expect(cells[0]).toContain("x");
    expect(cells[0]).toContain("y");
  });

  it("cannot inject a LINK, an element or a code span into the handover", () => {
    // This report is written into a HANDOVER -- a Markdown document the next
    // session reads as the record of what happened. `escapeMarkdownInline`,
    // which the rest of this file uses, guards line-leading markers and
    // deliberately preserves everything else, because its sinks are plain text.
    // Here that is the wrong contract: a ticket title carrying a link, a raw
    // element or a pair of backticks would author real structure inside the
    // project's own history.
    // DISTINCT per field, each with its own marker. With one shared string the
    // negative assertions below still hold if a field is never rendered at all,
    // so the suite could not tell "escaped" from "silently dropped" -- and a
    // field that stops appearing is a regression this file should catch.
    const payload = (marker: string): string =>
      `[click-${marker}](https://elsewhere.example) <img src=x onerror=1> \`code-${marker}\` **bold-${marker}** _em_`;
    // The ID fields are rendered strings too. Leaving them out of the hostile
    // set meant a live link or a forged column in a remaining-work ID would
    // have failed nothing here.
    const MARKERS = ["done", "remaining", "remainid", "issue", "issueid", "severity"] as const;
    const report = formatCompactReport({
      state: makeState({
        completedTickets: [{ id: "T-001", title: payload("done"), commitHash: "aaa" }],
      }),
      remainingWork: {
        tickets: [{ id: payload("remainid"), title: payload("remaining") }],
        issues: [{ id: payload("issueid"), title: payload("issue"), severity: payload("severity") }],
      },
    });

    // Each field really reached the report, so the assertions below are about
    // neutralization rather than absence.
    for (const m of MARKERS) {
      expect(report, `field ${m} was not rendered at all`).toContain(`bold-${m}`);
    }

    // No structure survives: no link, no element, no code span, no emphasis.
    expect(report).not.toContain("](https://elsewhere.example)");
    // Including the form escaping the BRACKETS does not reach. GitHub-flavoured
    // Markdown autolinks a bare `https://...`, so killing `[text](url)` and
    // stopping there leaves a payload that simply omits the wrapper with a live,
    // clickable link -- in a document that persists in the project's history.
    // The earlier version of this test asserted "no link survives" while
    // checking only the wrapper, so it was a stronger claim than its evidence.
    expect(report, "autolink").not.toContain("https://elsewhere.example");
    expect(report, "scheme separator left intact").not.toMatch(/https:\/\//);
    expect(report).not.toContain("<img");
    // Per FIELD, so a live code span or emphasis in any one of them is caught
    // rather than masked by the three that escaped correctly.
    for (const m of MARKERS) {
      expect(report, `live code span in ${m}`).not.toContain(`\`code-${m}\``);
      expect(report, `live emphasis in ${m}`).not.toContain(`**bold-${m}`);
      expect(report, `live link wrapper in ${m}`).not.toContain(`[click-${m}](`);
    }
    // ...and the text is still THERE, escaped rather than dropped. A reader has
    // to be able to see what the title actually said. `&#58;` renders as `:`,
    // so the address is still legible -- it just cannot form the contiguous
    // `://` an autolinker scans for.
    expect(report).toContain("click");
    expect(report).toContain("elsewhere.example");
    expect(report).toContain("https&#58;//elsewhere.example");
    // The angle brackets are entity-encoded rather than left to open a tag.
    expect(report).toContain("&lt;img");
  });

  it("cannot leave a live @MENTION either", () => {
    // The narrower `word@word` rule this replaced was aimed at email autolinks
    // and left the shorter form alone -- the same mistake bracket-escaping made
    // about links, where the shape being thought about was neutralized and the
    // shorter one stayed live. `@admin` is a MENTION on the surfaces that
    // render a handover: it notifies, it links, and it lends a
    // session-controlled string the appearance of naming a person.
    const report = formatCompactReport({
      state: makeState({
        completedTickets: [
          { id: "T-001", title: "ping @admin and ops@example.com", commitHash: "aaa" },
        ],
      }),
    });

    expect(report, "bare mention").not.toContain("@admin");
    expect(report, "email autolink").not.toContain("ops@example.com");
    // Rendered, not removed: `&#64;` displays as `@`, so a reader still sees
    // exactly what the title said.
    expect(report).toContain("&#64;admin");
    expect(report).toContain("ops&#64;example.com");
  });

  it("neutralizes pipes, newlines and control characters in the CELLS", () => {
    const report = formatCompactReport({
      state: makeState({
        completedTickets: [
          {
            id: "T-001",
            title: `Real | 5m |\n| T-999 | Forged entry | 0m |\n${ESC}[2K`,
            commitHash: "aaa",
            startedAt: new Date(Date.now() - 600000).toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
      }),
    });

    const rows = report.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
    // Header + exactly one ticket. The payload's text survives as TEXT -- the
    // point is that it can no longer be structure: it stays inside the one cell
    // it was written into instead of becoming a row of its own.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("T-999");
    expect(report).not.toContain(ESC);
    // Escaped, not deleted: the operator still sees the title that was recorded.
    expect(report).toContain("Real \\| 5m");
  });

  it("neutralizes them in the ID column too, which had no escaping at all", () => {
    const report = formatCompactReport({
      state: makeState({
        completedTickets: [{ id: "T-001 | forged | 0m |", title: "Title", commitHash: "aaa" }],
      }),
    });
    const rows = report.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("T-001 \\| forged");
  });
});
