/**
 * T-432 section 4: the issue-flow line.
 *
 * `now` is injected, so the window boundary is an assertion rather than a race.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeIssueFlow, formatIssueFlow, ISSUE_FLOW_SEMANTICS } from "../../src/core/issue-flow.js";
import { formatStatus, formatRecap } from "../../src/core/output-formatter.js";
import type { Issue } from "../../src/models/issue.js";

const NOW = new Date("2026-09-05T00:00:00.000Z");

function issue(o: {
  status?: string; discovered?: string | null; resolved?: string | null;
}): Issue {
  return {
    id: "ISS-1", title: "t", status: o.status ?? "open", severity: "medium",
    components: [], impact: "", resolution: null, location: [],
    discoveredDate: o.discovered === undefined ? "2026-09-01" : o.discovered,
    resolvedDate: o.resolved ?? null,
    relatedTickets: [], updatedAt: "2026-09-01T00:00:00.000Z",
  } as unknown as Issue;
}

describe("the window boundary", () => {
  it("a record exactly at the cutoff is INSIDE the window", () => {
    // Stated as a test rather than left to whichever comparison got typed:
    // `>=` and `>` differ by one record every day the boundary lands on one.
    const at = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeIssueFlow([issue({ discovered: at })], 30, NOW).opened).toBe(1);
  });

  it("a record one millisecond older is outside", () => {
    const before = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000 - 1).toISOString();
    expect(computeIssueFlow([issue({ discovered: before })], 30, NOW).opened).toBe(0);
  });
});

describe("the window is closed at BOTH ends", () => {
  it("a FUTURE discoveredDate is not activity in the last 30 days", () => {
    // With only a lower bound, a record dated next year counted as opened in
    // the window and moved the net balance, contradicting the semantics the
    // json publishes beside it.
    const flow = computeIssueFlow(
      [issue({ discovered: "2027-01-01" })], 30, NOW,
    );
    expect(flow.opened).toBe(0);
    expect(flow.futureDates).toBe(1);
  });

  it("a FUTURE resolvedDate is not a resolution in the window", () => {
    const flow = computeIssueFlow(
      [issue({ status: "resolved", discovered: "2020-01-01", resolved: "2099-01-01" })],
      30, NOW,
    );
    expect(flow.resolved).toBe(0);
    expect(flow.futureDates).toBe(1);
  });

  it("a record dated exactly NOW is inside", () => {
    const flow = computeIssueFlow([issue({ discovered: NOW.toISOString() })], 30, NOW);
    expect(flow.opened).toBe(1);
    expect(flow.futureDates).toBe(0);
  });

  it("one millisecond after now is outside", () => {
    const flow = computeIssueFlow(
      [issue({ discovered: new Date(NOW.getTime() + 1).toISOString() })], 30, NOW,
    );
    expect(flow.opened).toBe(0);
    expect(flow.futureDates).toBe(1);
  });

  it("ONE record with BOTH dates in the future counts TWO fields", () => {
    // The unit is the date field, not the record: a record can carry two
    // anomalous dates, and the semantics say so rather than letting a consumer
    // infer two anomalous records where there is one.
    const flow = computeIssueFlow(
      [issue({ status: "open", discovered: "2027-01-01", resolved: "2028-01-01" })],
      30, NOW,
    );
    expect(flow.futureDates).toBe(2);
    expect(ISSUE_FLOW_SEMANTICS.futureDates).toContain("separately");
  });

  it("future dates are surfaced on the line, not dropped silently", () => {
    const line = formatIssueFlow(computeIssueFlow([issue({ discovered: "2027-01-01" })], 30, NOW));
    expect(line).toContain("1 future date fields");
  });
});

describe("open matches the existing convention", () => {
  it("open counts `status !== resolved`, so inprogress counts as open", () => {
    // The line must not disagree with `activeIssueCount`, which is computed the
    // same way. Two counts of "open issues" that differ by one is worse than
    // either number alone.
    const flow = computeIssueFlow(
      [issue({ status: "open" }), issue({ status: "inprogress" }), issue({ status: "resolved", resolved: "2026-09-01" })],
      30, NOW,
    );
    expect(flow.open).toBe(2);
  });
});

describe("absent and unusable dates are reported, never assigned", () => {
  it("an unparseable discoveredDate is a missing date, not an opening", () => {
    const flow = computeIssueFlow([issue({ discovered: "not a date" })], 30, NOW);
    expect(flow.opened).toBe(0);
    expect(flow.missingDates).toBe(1);
  });

  it("a resolved record with no date is a missing date, not a resolution in this window", () => {
    // Dropping it into the current window would manufacture a resolution that
    // may have happened years ago.
    const flow = computeIssueFlow([issue({ status: "resolved", resolved: null })], 30, NOW);
    expect(flow.resolved).toBe(0);
    expect(flow.missingDates).toBe(1);
  });

  it("missing dates are printed beside the counts", () => {
    const flow = computeIssueFlow([issue({ discovered: null })], 30, NOW);
    expect(formatIssueFlow(flow)).toContain("1 missing dates");
  });
});

describe("activeWithResolvedDate is observed, not interpreted", () => {
  it("a non-resolved record carrying resolvedDate is counted under that name", () => {
    const flow = computeIssueFlow(
      [issue({ status: "open", resolved: "2026-09-02" })], 30, NOW,
    );
    expect(flow.activeWithResolvedDate).toBe(1);
    // It still counts in the resolved window: the date is in the window and the
    // window is over dates.
    expect(flow.resolved).toBe(1);
    // and it is still open
    expect(flow.open).toBe(1);
  });

  it("the rendered line never calls it a reopen", () => {
    // A reopen is one explanation; an inconsistent or stale edit is another, and
    // the records cannot tell them apart.
    const line = formatIssueFlow(computeIssueFlow(
      [issue({ status: "open", resolved: "2026-09-02" })], 30, NOW,
    ));
    expect(line).toContain("activeWithResolvedDate");
    expect(line.toLowerCase()).not.toContain("reopen");
  });
});

describe("the line says what it is", () => {
  it("net is a balance of record dates and the semantics say so", () => {
    const flow = computeIssueFlow([
      issue({ discovered: "2026-09-01" }),
      issue({ discovered: "2026-09-02" }),
      issue({ status: "resolved", discovered: "2020-01-01", resolved: "2026-09-03" }),
    ], 30, NOW);
    expect(flow.opened).toBe(2);
    expect(flow.resolved).toBe(1);
    expect(flow.net).toBe(1);
    expect(formatIssueFlow(flow)).toBe("Issues: 2 open (30d: +2 opened / -1 resolved, net +1)");
    expect(ISSUE_FLOW_SEMANTICS.isNot).toBe("change in the open backlog");
  });

  it("a negative net keeps its sign and gains no plus", () => {
    const flow = computeIssueFlow([
      issue({ status: "resolved", discovered: "2020-01-01", resolved: "2026-09-03" }),
    ], 30, NOW);
    expect(formatIssueFlow(flow)).toContain("net -1");
  });
});

describe("the status line when the records are not available", () => {
  const partial = (activeIssues?: unknown) => ({
    config: { project: "p" },
    completeLeafTicketCount: 0, leafTicketCount: 0, blockedCount: 0,
    activeIssueCount: 7,
    activeNoteCount: 0, archivedNoteCount: 0,
    activeLessonCount: 0, deprecatedLessonCount: 0,
    handoverFilenames: [], phases: [], tickets: [], roadmap: { phases: [] },
    ...(activeIssues === undefined ? {} : { activeIssues }),
  }) as never;

  it("prints NO WINDOW rather than a window of zeros", () => {
    // "+0 opened / -0 resolved" over records we never read is a fabricated
    // zero, which is the one thing this ticket exists to prevent. A caller
    // holding only the counts gets the plain line it always got.
    const md = formatStatus(partial(), "md", [], [], undefined, [], []);
    expect(md).toContain("Issues: 7 open");
    expect(md).not.toContain("30d:");
    expect(md).not.toContain("opened");
  });

  it("the json carries NULL, so a consumer can tell absent from zero", () => {
    const json = JSON.parse(formatStatus(partial(), "json", [], [], undefined, [], []));
    expect(json.data.issueFlow).toBeNull();
    // and the existing count is untouched
    expect(json.data.openIssues).toBe(7);
  });

  it("with records present, the window appears and agrees with the count", () => {
    // FROZEN for the same reason as the recap block below, and asserted on the
    // EXACT count. `\\+\\d+` also matches `+0`, so on the real clock this test
    // would keep passing once the fixture date aged out of the window while
    // measuring nothing.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const issues = [issue({ status: "open", discovered: "2026-09-01" })];
      const md = formatStatus(partial(issues), "md", [], [], undefined, [], []);
      // `open` comes from the same records, so it is 1 here, not activeIssueCount.
      expect(md).toContain("Issues: 1 open (30d: +1 opened / -0 resolved, net +1)");
    } finally { vi.useRealTimers(); }
  });
});

describe("recap carries the same line and the nudge", () => {
  // THE CLOCK IS FROZEN, because `formatRecap` reaches `new Date()` through
  // `statusIssueFlow` and this block's fixtures are fixed September 2026 dates.
  // Left on the real clock these are TIME BOMBS: once those dates leave the
  // 30-day window the positive assertions fail, and worse, the negative
  // controls start passing for the wrong reason -- a nudge absent because the
  // window emptied looks exactly like a nudge correctly withheld.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const emptyDiff = {
    tickets: { added: [], removed: [], statusChanged: [], descriptionChanged: [] },
    issues: { added: [], resolved: [], statusChanged: [], impactChanged: [] },
    blockers: { added: [], cleared: [] },
    phases: { added: [], removed: [], statusChanged: [] },
    notes: { added: [], removed: [], updated: [] },
    handovers: { added: [], removed: [] },
    lessons: { added: [], removed: [], updated: [], reinforced: [] },
  };
  const recapOf = (withSnapshot: boolean) => ({
    snapshot: withSnapshot ? { filename: "s.json", createdAt: "2026-09-01T00:00:00.000Z" } : null,
    changes: withSnapshot ? emptyDiff : null,
    suggestedActions: { nextTicket: null, highSeverityIssues: [], recentlyClearedBlockers: [] },
    partial: false,
  }) as never;
  const stateOf = (issues?: readonly Issue[]) => ({
    config: { project: "p" },
    completeLeafTicketCount: 0, leafTicketCount: 0, blockedCount: 0,
    activeIssueCount: 1,
    activeNoteCount: 0, archivedNoteCount: 0,
    activeLessonCount: 0, deprecatedLessonCount: 0,
    handoverFilenames: [], phases: [], tickets: [], roadmap: { phases: [] },
    ...(issues === undefined ? {} : { activeIssues: issues }),
  }) as never;

  it("the WITH-SNAPSHOT branch prints the line, not just the fallback", () => {
    // It was wired only into the no-snapshot fallback, so the branch a reader
    // actually reaches never showed it, and the plan recorded the line as
    // delivered on the strength of the branch nobody hits.
    const md = formatRecap(recapOf(true), stateOf([issue({ discovered: "2026-09-01" })]), "md");
    expect(md).toContain("Since snapshot:");
    expect(md).toMatch(/Issues: 1 open \(30d: \+1 opened/);
  });

  it("the nudge fires when more opened than resolved, and names the balance", () => {
    const md = formatRecap(recapOf(true), stateOf([
      issue({ discovered: "2026-09-01" }),
      issue({ discovered: "2026-09-02" }),
    ]), "md");
    expect(md).toContain("**Issue flow:**");
    expect(md).toContain("net +2");
    // It must NOT claim the backlog grew: a single resolvedDate cannot
    // represent a close-reopen-close cycle and a deleted issue leaves no record.
    expect(md).toContain("NOT a change in the open backlog");
    expect(md).not.toContain("No urgent actions.");
  });

  it("NEGATIVE CONTROL: no nudge when resolutions match or exceed openings", () => {
    const md = formatRecap(recapOf(true), stateOf([
      issue({ status: "resolved", discovered: "2020-01-01", resolved: "2026-09-02" }),
    ]), "md");
    expect(md).not.toContain("**Issue flow:**");
    // and with nothing else to suggest, the existing line still appears
    expect(md).toContain("No urgent actions.");
  });

  it("NEGATIVE CONTROL: PARITY does not nudge -- the condition is opened > resolved", () => {
    // The first negative control only covered net BELOW zero, so `>=` passed it
    // unchanged; a mutant found that gap. Parity is the boundary the condition
    // actually turns on, and an equal number opened and resolved is not a
    // growing balance.
    const md = formatRecap(recapOf(true), stateOf([
      issue({ discovered: "2026-09-01" }),
      issue({ status: "resolved", discovered: "2020-01-01", resolved: "2026-09-02" }),
    ]), "md");
    expect(md).toMatch(/net \+?0\b/);
    expect(md).not.toContain("**Issue flow:**");
  });

  it("NEGATIVE CONTROL: no records means no line and no nudge, never a zero", () => {
    const md = formatRecap(recapOf(true), stateOf(undefined), "md");
    expect(md).toContain("Issues: 1 open");
    expect(md).not.toContain("30d:");
    expect(md).not.toContain("**Issue flow:**");
  });
});
