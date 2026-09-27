import { describe, it, expect } from "vitest";
import * as outputFormatter from "../../src/core/output-formatter.js";
import {
  successEnvelope,
  errorEnvelope,
  partialEnvelope,
  escapeMarkdownInline,
  escapeMarkdownDocument,
  fencedBlock,
  stripRenderFence,
  formatStatus,
  formatFederatedStatus,
  formatPhaseList,
  formatTicket,
  formatNextTicketOutcome,
  formatNextTicketsOutcome,
  formatTicketList,
  formatIssue,
  formatIssueList,
  formatValidation,
  VALIDATION_GROUP_LIST_LIMIT,
  formatBlockerList,
  formatError,
  formatInitResult,
  formatRecommendations,
} from "../../src/core/output-formatter.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makeRoadmap, makePhase } from "./test-factories.js";
import type { NextTicketOutcome, NextTicketsOutcome } from "../../src/core/queries.js";
import type { RecommendResult } from "../../src/core/recommend.js";
import type { TrajectoryEntry } from "../../src/core/markdown-sections.js";
import type { ValidationResult, ValidationFinding } from "../../src/core/validation.js";
import type { Ruling } from "../../src/models/ruling.js";

describe("envelopes", () => {
  it("successEnvelope wraps data with version 1", () => {
    const env = successEnvelope({ foo: "bar" });
    expect(env.version).toBe(1);
    expect(env.data).toEqual({ foo: "bar" });
  });

  it("errorEnvelope wraps code and message", () => {
    const env = errorEnvelope("not_found", "Ticket not found");
    expect(env.version).toBe(1);
    expect(env.error.code).toBe("not_found");
    expect(env.error.message).toBe("Ticket not found");
  });

  it("partialEnvelope includes warnings and partial flag", () => {
    const env = partialEnvelope({ data: 1 }, [
      { file: "test.json", message: "bad", type: "parse_error" },
    ]);
    expect(env.version).toBe(1);
    expect(env.partial).toBe(true);
    expect(env.warnings).toHaveLength(1);
  });
});

describe("escapeMarkdownInline", () => {
  it("escapes heading chars at line start", () => {
    expect(escapeMarkdownInline("# Title")).toContain("\\#");
  });

  it("escapes list chars at line start", () => {
    expect(escapeMarkdownInline("- item")).toContain("\\-");
    expect(escapeMarkdownInline("* bold")).toContain("\\*");
    expect(escapeMarkdownInline("+ list")).toContain("\\+");
  });

  it("escapes ordered lists at line start", () => {
    expect(escapeMarkdownInline("1. item")).toContain("1\\.");
  });

  it("escapes line-start markers after a newline", () => {
    expect(escapeMarkdownInline("first\n# second")).toContain("\\#");
  });

  // Plain-text sinks (CLI stdout, MCP text): inline/HTML/backslash escaping was
  // removed, so these must pass through verbatim rather than leak escape noise.
  it("passes blockquote markers through unescaped", () => {
    expect(escapeMarkdownInline("> quote")).toBe("> quote");
  });

  it("passes inline structural chars through unescaped", () => {
    expect(escapeMarkdownInline("use `code` and *bold*")).toBe("use `code` and *bold*");
  });

  it("passes brackets and parens through unescaped", () => {
    expect(escapeMarkdownInline("[click](http://example.com)")).toBe("[click](http://example.com)");
  });

  it("passes angle brackets through unescaped (no HTML entities)", () => {
    expect(escapeMarkdownInline("<script>alert('x')</script>")).toBe("<script>alert('x')</script>");
  });

  it("passes ampersands through unescaped", () => {
    expect(escapeMarkdownInline("A & B")).toBe("A & B");
  });

  it("passes backslashes through unescaped", () => {
    expect(escapeMarkdownInline("C:\\tmp\\file")).toBe("C:\\tmp\\file");
  });

  it("does not escape normal text", () => {
    expect(escapeMarkdownInline("Hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownInline("")).toBe("");
  });
});

describe("escapeMarkdownDocument", () => {
  // The export document is opened in a real Markdown viewer, so unlike the
  // plain-text inline escaper, this one must neutralize inline structure, HTML,
  // and link injection.
  it("escapes heading and list markers at line start", () => {
    expect(escapeMarkdownDocument("# Title")).toContain("\\#");
    expect(escapeMarkdownDocument("- item")).toContain("\\-");
    expect(escapeMarkdownDocument("1. item")).toContain("1\\.");
  });

  it("escapes inline structural chars", () => {
    expect(escapeMarkdownDocument("use `code` and *bold*")).toBe(
      "use \\`code\\` and \\*bold\\*",
    );
    expect(escapeMarkdownDocument("a_b~c")).toBe("a\\_b\\~c");
  });

  it("escapes link and table syntax", () => {
    expect(escapeMarkdownDocument("[click](http://x)")).toBe(
      "\\[click\\]\\(http://x\\)",
    );
    expect(escapeMarkdownDocument("a|b")).toBe("a\\|b");
  });

  it("escapes HTML to entities", () => {
    expect(escapeMarkdownDocument("<b>hi</b>")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("escapes ampersands to entities", () => {
    expect(escapeMarkdownDocument("A & B")).toBe("A &amp; B");
  });

  it("escapes backslashes first so later escapes are not doubled", () => {
    expect(escapeMarkdownDocument("C:\\tmp")).toBe("C:\\\\tmp");
  });

  it("does not escape normal text", () => {
    expect(escapeMarkdownDocument("Hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownDocument("")).toBe("");
  });
});

describe("escapeMarkdownInline at formatter boundaries", () => {
  it("escapes a phase name starting with a heading marker in formatStatus md", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1", name: "# Heading Phase" })]),
    });
    const md = formatStatus(state, "md");
    expect(md).toContain("\\# Heading Phase");
    expect(md).not.toContain("**# Heading Phase**");
  });

  it("escapes a phase name starting with a list marker in formatStatus md", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1", name: "- Dash Phase" })]),
    });
    const md = formatStatus(state, "md");
    expect(md).toContain("\\- Dash Phase");
  });
});

describe("fencedBlock", () => {
  it("wraps content in triple backticks", () => {
    const result = fencedBlock("hello");
    expect(result).toBe("```\nhello\n```");
  });

  it("includes language specifier", () => {
    const result = fencedBlock("const x = 1;", "ts");
    expect(result).toBe("```ts\nconst x = 1;\n```");
  });

  it("handles content with triple backticks", () => {
    const result = fencedBlock("has ``` inside");
    // Should use 4 backticks as fence
    expect(result.startsWith("````")).toBe(true);
    expect(result.endsWith("````")).toBe(true);
  });
});

describe("stripRenderFence (ISS-1192)", () => {
  it("strips a whole-input 4-backtick fence with no info string", () => {
    const result = stripRenderFence(fencedBlock("has ``` inside"));
    expect(result).toEqual({ text: "has ``` inside", stripped: true });
  });

  it("round-trips: fencedBlock then stripRenderFence recovers the exact original, and is idempotent on the result", () => {
    const original = "line one\nline two with ``` a fence\nline three";
    const rendered = fencedBlock(original);
    const first = stripRenderFence(rendered);
    expect(first).toEqual({ text: original, stripped: true });
    const second = stripRenderFence(first.text);
    expect(second).toEqual({ text: original, stripped: false });
  });

  it("never strips a whole-input 3-backtick fence (named mutant: lowering the threshold to 3 must make this red)", () => {
    const input = "```\nhello\n```";
    expect(stripRenderFence(input)).toEqual({ text: input, stripped: false });
  });

  it("never strips a 4-backtick fence carrying an info string", () => {
    const input = "````ts\nconst x = 1;\n````";
    expect(stripRenderFence(input)).toEqual({ text: input, stripped: false });
  });

  it("never strips when there is text outside the fence", () => {
    const input = "some prose\n````\nfenced\n````";
    expect(stripRenderFence(input)).toEqual({ text: input, stripped: false });
    const input2 = "````\nfenced\n````\nmore prose";
    expect(stripRenderFence(input2)).toEqual({ text: input2, stripped: false });
  });

  it("trims only outer whitespace, preserving inner leading/trailing newlines", () => {
    const input = "  \n````\n\nline one\n\n````\n  ";
    expect(stripRenderFence(input)).toEqual({ text: "\nline one\n", stripped: true });
  });

  it("matches the closing fence at the end of input only, never an inner fence of the same length", () => {
    // The content itself contains a line that is exactly 4 backticks; the true
    // outer closer is the LAST such line, at the true end of input.
    const input = "````\nfirst\n````\nsecond\n````";
    const result = stripRenderFence(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toBe("first\n````\nsecond");
  });
});

describe("formatStatus", () => {
  it("JSON returns valid parseable envelope", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const json = formatStatus(state, "json");
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.data.project).toBe("test");
    expect(parsed.data.completeTickets).toBe(1);
  });

  it("MD returns readable summary", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const md = formatStatus(state, "md");
    expect(md).toContain("Tickets:");
    expect(md).toContain("Phases");
  });

  it("counts exclude umbrellas (leaf-only)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }), // umbrella
        makeTicket({ id: "T-002", phase: "p1", status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", phase: "p1", status: "open", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const json = formatStatus(state, "json");
    const parsed = JSON.parse(json);
    // 2 leaf tickets (T-002 complete, T-003 open), umbrella T-001 excluded
    expect(parsed.data.totalTickets).toBe(2);
    expect(parsed.data.completeTickets).toBe(1);
    expect(parsed.data.openTickets).toBe(1);
    const md = formatStatus(state, "md");
    expect(md).toContain("1/2 complete");
  });

  it("handles deeply nested umbrellas", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }), // top umbrella
        makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001" }), // mid umbrella
        makeTicket({ id: "T-003", phase: "p1", status: "complete", parentTicket: "T-002" }), // leaf
        makeTicket({ id: "T-004", phase: "p1", status: "open", parentTicket: "T-002" }), // leaf
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const json = formatStatus(state, "json");
    const parsed = JSON.parse(json);
    // 2 leaf tickets, umbrellas T-001 and T-002 excluded
    expect(parsed.data.totalTickets).toBe(2);
    expect(parsed.data.completeTickets).toBe(1);
  });

  it("JSON includes isEmptyScaffold: true for empty scaffold", () => {
    const state = makeState();
    const json = formatStatus(state, "json");
    const parsed = JSON.parse(json);
    expect(parsed.data.isEmptyScaffold).toBe(true);
  });

  it("JSON includes isEmptyScaffold: false for populated project", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const json = formatStatus(state, "json");
    const parsed = JSON.parse(json);
    expect(parsed.data.isEmptyScaffold).toBe(false);
  });

  it("markdown includes Getting Started section for empty scaffold", () => {
    const state = makeState();
    const md = formatStatus(state, "md");
    expect(md).toContain("## Getting Started");
    expect(md).toContain("no tickets, issues, or handovers yet");
  });

  it("markdown excludes Getting Started section for populated project", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const md = formatStatus(state, "md");
    expect(md).not.toContain("## Getting Started");
  });
});

describe("formatPhaseList", () => {
  it("prefers Phase.summary over description", () => {
    const state = makeState({
      roadmap: makeRoadmap([
        makePhase({ id: "p1", description: "Long description here.", summary: "Short." }),
      ]),
    });
    const md = formatPhaseList(state, "md");
    expect(md).toContain("Short.");
  });

  it("truncates long description when no summary", () => {
    const longDesc = "A".repeat(120);
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1", description: longDesc })]),
    });
    const md = formatPhaseList(state, "md");
    expect(md).toContain("...");
    expect(md.length).toBeLessThan(longDesc.length + 100);
  });
});

describe("formatNextTicketOutcome", () => {
  it("formats found ticket with unblock impact", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const outcome: NextTicketOutcome = {
      kind: "found",
      ticket: state.tickets[0]!,
      unblockImpact: { ticketId: "T-001", wouldUnblock: [state.tickets[1]!] },
      umbrellaProgress: null,
    };
    const md = formatNextTicketOutcome(outcome, state, "md");
    expect(md).toContain("T-001");
    expect(md).toContain("Completing this unblocks");
    expect(md).toContain("T-002");
  });

  it("formats all_complete", () => {
    const state = makeState();
    const outcome: NextTicketOutcome = { kind: "all_complete" };
    const md = formatNextTicketOutcome(outcome, state, "md");
    expect(md).toContain("All phases complete");
  });

  it("formats all_blocked", () => {
    const state = makeState();
    const outcome: NextTicketOutcome = { kind: "all_blocked", phaseId: "p1", blockedCount: 3 };
    const md = formatNextTicketOutcome(outcome, state, "md");
    expect(md).toContain("blocked");
    expect(md).toContain("p1");
  });

  it("formats empty_project", () => {
    const state = makeState();
    const md = formatNextTicketOutcome({ kind: "empty_project" }, state, "md");
    expect(md).toContain("No phased tickets");
  });

  it("JSON is valid for all outcome types", () => {
    const state = makeState();
    for (const outcome of [
      { kind: "empty_project" } as NextTicketOutcome,
      { kind: "all_complete" } as NextTicketOutcome,
      { kind: "all_blocked", phaseId: "p1", blockedCount: 2 } as NextTicketOutcome,
    ]) {
      const json = formatNextTicketOutcome(outcome, state, "json");
      expect(() => JSON.parse(json)).not.toThrow();
    }
  });
});

describe("formatNextTicketsOutcome", () => {
  it("single candidate uses # Next: format", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", description: "Do stuff" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const outcome: NextTicketsOutcome = {
      kind: "found",
      candidates: [{
        ticket: state.tickets[0]!,
        unblockImpact: { ticketId: "T-001", wouldUnblock: [] },
        umbrellaProgress: null,
      }],
      skippedBlockedPhases: [],
    };
    const md = formatNextTicketsOutcome(outcome, state, "md");
    expect(md).toContain("# Next: T-001");
    expect(md).not.toContain("# 1.");
  });

  it("multiple candidates use numbered format with separator", () => {
    const t1 = makeTicket({ id: "T-001", phase: "p1", order: 10 });
    const t2 = makeTicket({ id: "T-002", phase: "p1", order: 20 });
    const state = makeState({
      tickets: [t1, t2],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const outcome: NextTicketsOutcome = {
      kind: "found",
      candidates: [
        { ticket: t1, unblockImpact: { ticketId: "T-001", wouldUnblock: [] }, umbrellaProgress: null },
        { ticket: t2, unblockImpact: { ticketId: "T-002", wouldUnblock: [] }, umbrellaProgress: null },
      ],
      skippedBlockedPhases: [],
    };
    const md = formatNextTicketsOutcome(outcome, state, "md");
    expect(md).toContain("# 1. T-001");
    expect(md).toContain("# 2. T-002");
    expect(md).toContain("---");
  });

  it("JSON contains candidates array and skippedBlockedPhases", () => {
    const t1 = makeTicket({ id: "T-001", phase: "p1" });
    const state = makeState({ tickets: [t1] });
    const outcome: NextTicketsOutcome = {
      kind: "found",
      candidates: [{
        ticket: t1,
        unblockImpact: { ticketId: "T-001", wouldUnblock: [] },
        umbrellaProgress: null,
      }],
      skippedBlockedPhases: [{ phaseId: "p0", blockedCount: 2 }],
    };
    const json = formatNextTicketsOutcome(outcome, state, "json");
    const parsed = JSON.parse(json);
    expect(parsed.data.candidates).toHaveLength(1);
    expect(parsed.data.skippedBlockedPhases).toHaveLength(1);
  });

  it("renders skipped phases footer when present", () => {
    const t1 = makeTicket({ id: "T-001", phase: "p2" });
    const state = makeState({ tickets: [t1] });
    const outcome: NextTicketsOutcome = {
      kind: "found",
      candidates: [{
        ticket: t1,
        unblockImpact: { ticketId: "T-001", wouldUnblock: [] },
        umbrellaProgress: null,
      }],
      skippedBlockedPhases: [{ phaseId: "p1", blockedCount: 3 }],
    };
    const md = formatNextTicketsOutcome(outcome, state, "md");
    expect(md).toContain("Skipped blocked phases");
    expect(md).toContain("p1 (3 blocked)");
  });

  it("all_blocked with multiple phases lists all", () => {
    const state = makeState();
    const outcome: NextTicketsOutcome = {
      kind: "all_blocked",
      phases: [
        { phaseId: "p1", blockedCount: 2 },
        { phaseId: "p2", blockedCount: 3 },
      ],
    };
    const md = formatNextTicketsOutcome(outcome, state, "md");
    expect(md).toContain("p1 (2 blocked)");
    expect(md).toContain("p2 (3 blocked)");
    expect(md).toContain("2 phases");
  });

  it("renders umbrella progress when populated", () => {
    const t1 = makeTicket({ id: "T-001", phase: "p1" });
    const state = makeState({ tickets: [t1] });
    const outcome: NextTicketsOutcome = {
      kind: "found",
      candidates: [{
        ticket: t1,
        unblockImpact: { ticketId: "T-001", wouldUnblock: [] },
        umbrellaProgress: { total: 5, complete: 2, status: "inprogress" },
      }],
      skippedBlockedPhases: [],
    };
    const md = formatNextTicketsOutcome(outcome, state, "md");
    expect(md).toContain("Parent progress: 2/5 complete (inprogress)");
  });

  it("JSON is valid for all outcome types", () => {
    const state = makeState();
    const outcomes: NextTicketsOutcome[] = [
      { kind: "empty_project" },
      { kind: "all_complete" },
      { kind: "all_blocked", phases: [{ phaseId: "p1", blockedCount: 2 }] },
    ];
    for (const outcome of outcomes) {
      const json = formatNextTicketsOutcome(outcome, state, "json");
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(1);
    }
  });

  it("terminal states produce correct messages", () => {
    const state = makeState();
    expect(formatNextTicketsOutcome({ kind: "all_complete" }, state, "md")).toContain("All phases complete");
    expect(formatNextTicketsOutcome({ kind: "empty_project" }, state, "md")).toContain("No phased tickets");
  });
});

describe("formatError", () => {
  it("JSON returns error envelope", () => {
    const json = formatError("not_found", "Ticket T-999 not found", "json");
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.error.code).toBe("not_found");
  });

  it("MD returns readable error", () => {
    const md = formatError("not_found", "Ticket T-999 not found", "md");
    expect(md).toContain("not_found");
    expect(md).toContain("T-999");
  });
});

describe("formatValidation", () => {
  it("shows error/warning/info counts", () => {
    const result: ValidationResult = {
      valid: false,
      errorCount: 2,
      warningCount: 1,
      infoCount: 0,
      findings: [
        { level: "error", code: "test", message: "Error 1", entity: "T-001" },
        { level: "error", code: "test", message: "Error 2", entity: "T-002" },
        { level: "warning", code: "test", message: "Warning 1", entity: null },
      ],
    };
    const md = formatValidation(result, "md");
    expect(md).toContain("Errors: 2");
    expect(md).toContain("Warnings: 1");
    expect(md).toContain("failed");
  });

  it("JSON is valid", () => {
    const result: ValidationResult = { valid: true, errorCount: 0, warningCount: 0, infoCount: 0, findings: [] };
    const json = formatValidation(result, "json");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  describe("grouping (ISS-890)", () => {
    const finding = (
      level: ValidationFinding["level"],
      code: string,
      n: number,
    ): ValidationFinding[] =>
      Array.from({ length: n }, (_, i) => ({
        level,
        code,
        message: `${code} occurrence ${i + 1}`,
        entity: `E-${i + 1}`,
      }));

    const build = (findings: ValidationFinding[]): ValidationResult => ({
      valid: !findings.some((f) => f.level === "error"),
      errorCount: findings.filter((f) => f.level === "error").length,
      warningCount: findings.filter((f) => f.level === "warning").length,
      infoCount: findings.filter((f) => f.level === "info").length,
      findings,
    });

    const headings = (md: string): string[] =>
      md.split("\n").filter((l) => l.startsWith("## "));

    it("groups findings by code with a count on each heading", () => {
      const md = formatValidation(
        build([...finding("warning", "orphan_issue", 2), ...finding("warning", "blocked_by_deleted", 1)]),
        "md",
      );
      expect(md).toContain("## blocked_by_deleted -- 1 finding");
      expect(md).toContain("## orphan_issue -- 2 findings");
    });

    it("puts the specific above the systemic: smallest group first within a level", () => {
      // The reported defect: three real blocked_by_deleted warnings were
      // indistinguishable from ninety-two orphan_issue ones in a flat list.
      const md = formatValidation(
        build([
          ...finding("warning", "orphan_issue", 92),
          ...finding("warning", "blocked_by_deleted", 3),
          ...finding("warning", "source_ref_changed_at_head", 5),
        ]),
        "md",
      );
      expect(headings(md)).toEqual([
        "## blocked_by_deleted -- 3 findings",
        "## source_ref_changed_at_head -- 5 findings",
        "## orphan_issue -- 92 findings",
      ]);
    });

    it("keeps errors above warnings above info regardless of group size", () => {
      const md = formatValidation(
        build([
          ...finding("info", "duplicate_order", 1),
          ...finding("warning", "orphan_issue", 1),
          ...finding("error", "duplicate_ticket_id", 40),
        ]),
        "md",
      );
      expect(headings(md)).toEqual([
        "## duplicate_ticket_id -- 40 findings",
        "## orphan_issue -- 1 finding",
        "## duplicate_order -- 1 finding",
      ]);
    });

    it("breaks ties on code so the output is deterministic", () => {
      const md = formatValidation(
        build([...finding("warning", "zzz_last", 2), ...finding("warning", "aaa_first", 2)]),
        "md",
      );
      expect(headings(md)).toEqual([
        "## aaa_first -- 2 findings",
        "## zzz_last -- 2 findings",
      ]);
    });

    it("abbreviates a large group and says exactly how much it held back", () => {
      const md = formatValidation(build(finding("warning", "orphan_issue", 92)), "md");
      const listed = md.split("\n").filter((l) => l.startsWith("WARN:"));
      expect(listed).toHaveLength(VALIDATION_GROUP_LIST_LIMIT);
      expect(md).toContain("... and 82 more.");
      // Never a silent cap: the remainder line names where the rest lives.
      expect(md).toContain("storybloq validate --format json");
    });

    it("never abbreviates errors, which are what make validation fail", () => {
      const md = formatValidation(build(finding("error", "duplicate_ticket_id", 40)), "md");
      expect(md.split("\n").filter((l) => l.startsWith("ERROR:"))).toHaveLength(40);
      expect(md).not.toContain("more. Run");
    });

    it("adds no remainder line when a group fits", () => {
      const md = formatValidation(
        build(finding("warning", "orphan_issue", VALIDATION_GROUP_LIST_LIMIT)),
        "md",
      );
      expect(md.split("\n").filter((l) => l.startsWith("WARN:"))).toHaveLength(
        VALIDATION_GROUP_LIST_LIMIT,
      );
      expect(md).not.toContain("more. Run");
    });

    it("leaves JSON complete and ungrouped, so machine consumers lose nothing", () => {
      // The grouping and the limit are a reading aid for humans, never a filter
      // on what the data says.
      const findings = finding("warning", "orphan_issue", 92);
      const parsed = JSON.parse(formatValidation(build(findings), "json")) as {
        data: { findings: ValidationFinding[] };
      };
      expect(parsed.data.findings).toHaveLength(92);
      expect(parsed.data.findings).toEqual(findings);
    });

    it("still names entities and levels on each listed line", () => {
      const md = formatValidation(
        build([
          { level: "error", code: "self_ref_parent", message: "T-001 is its own parent.", entity: "T-001" },
          { level: "info", code: "duplicate_order", message: "Two tickets share order 10.", entity: null },
        ]),
        "md",
      );
      expect(md).toContain("ERROR: [T-001] T-001 is its own parent.");
      expect(md).toContain("INFO: Two tickets share order 10.");
    });
  });
});

describe("formatInitResult", () => {
  it("JSON is valid", () => {
    const json = formatInitResult({ root: "/tmp/test", created: [".story/config.json"], warnings: [] }, "json");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("MD shows created files", () => {
    const md = formatInitResult({ root: "/tmp/test", created: [".story/config.json"], warnings: [] }, "md");
    expect(md).toContain("config.json");
  });

  it("MD shows warning when corrupt files found", () => {
    const md = formatInitResult({ root: "/tmp/test", created: [".story/config.json"], warnings: [".story/tickets/T-099.json"] }, "md");
    expect(md).toContain("1 corrupt file(s) found");
    expect(md).toContain("storybloq validate");
  });

  it("JSON includes warnings array", () => {
    const json = formatInitResult({ root: "/tmp/test", created: [".story/config.json"], warnings: [".story/tickets/T-099.json"] }, "json");
    const parsed = JSON.parse(json);
    expect(parsed.data.warnings).toEqual([".story/tickets/T-099.json"]);
  });

  it("MD omits warning line when no corrupt files", () => {
    const md = formatInitResult({ root: "/tmp/test", created: [".story/config.json"], warnings: [] }, "md");
    expect(md).not.toContain("corrupt");
  });
});

describe("all format functions produce valid JSON", () => {
  const state = makeState({
    tickets: [makeTicket({ id: "T-001", phase: "p1" })],
    issues: [makeIssue({ id: "ISS-001" })],
    roadmap: makeRoadmap([makePhase({ id: "p1" })]),
  });

  it("formatTicketList", () => {
    expect(() => JSON.parse(formatTicketList(state.tickets, "json"))).not.toThrow();
  });

  it("formatIssueList", () => {
    expect(() => JSON.parse(formatIssueList(state.issues, "json"))).not.toThrow();
  });

  it("formatBlockerList", () => {
    expect(() => JSON.parse(formatBlockerList(state.roadmap, "json"))).not.toThrow();
  });
});

describe("formatRecommendations", () => {
  const populatedState = makeState({ tickets: [makeTicket({ id: "T-001" })] });

  it("markdown numbered list with reason lines", () => {
    const result: RecommendResult = {
      recommendations: [
        { id: "ISS-001", kind: "issue", title: "Bug", category: "critical_issue", reason: "Critical issue", score: 900 },
        { id: "T-001", kind: "ticket", title: "Task", category: "inprogress_ticket", reason: "In-progress", score: 800 },
      ],
      totalCandidates: 2,
      excludedCount: 0,
      excluded: [],
      unreadableHandoverCount: 0,
    };
    const md = formatRecommendations(result, populatedState, "md");
    expect(md).toContain("# Recommendations");
    expect(md).toContain("1. **ISS-001** (issue)");
    expect(md).toContain("2. **T-001** (ticket)");
    expect(md).toContain("_Critical issue_");
    expect(md).toContain("_In-progress_");
  });

  it("empty + populated → 'complete or blocked' message", () => {
    const result: RecommendResult = { recommendations: [], totalCandidates: 0, excludedCount: 0, excluded: [], unreadableHandoverCount: 0 };
    const md = formatRecommendations(result, populatedState, "md");
    expect(md).toContain("No recommendations");
    expect(md).toContain("complete or blocked");
  });

  it("empty + empty scaffold → setup message", () => {
    const result: RecommendResult = { recommendations: [], totalCandidates: 0, excludedCount: 0, excluded: [], unreadableHandoverCount: 0 };
    const scaffoldState = makeState();
    const md = formatRecommendations(result, scaffoldState, "md");
    expect(md).toContain("No recommendations yet");
    expect(md).toContain("/story setup flow");
  });

  it("JSON envelope with recommendations + totalCandidates", () => {
    const result: RecommendResult = {
      recommendations: [
        { id: "T-001", kind: "ticket", title: "Task", category: "quick_win", reason: "Chore", score: 400 },
      ],
      totalCandidates: 5,
      excludedCount: 0,
      excluded: [],
      unreadableHandoverCount: 0,
    };
    const json = formatRecommendations(result, populatedState, "json");
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.data.recommendations).toHaveLength(1);
    expect(parsed.data.totalCandidates).toBe(5);
    expect(parsed.data.isEmptyScaffold).toBe(false);
  });

  it("JSON envelope includes isEmptyScaffold: true for scaffold", () => {
    const result: RecommendResult = { recommendations: [], totalCandidates: 0, excludedCount: 0, excluded: [], unreadableHandoverCount: 0 };
    const scaffoldState = makeState();
    const json = formatRecommendations(result, scaffoldState, "json");
    const parsed = JSON.parse(json);
    expect(parsed.data.isEmptyScaffold).toBe(true);
  });

  it("footer shows 'Showing X of Y' when truncated", () => {
    const result: RecommendResult = {
      recommendations: [
        { id: "T-001", kind: "ticket", title: "Task", category: "quick_win", reason: "Chore", score: 400 },
      ],
      totalCandidates: 8,
      excludedCount: 0,
      excluded: [],
      unreadableHandoverCount: 0,
    };
    const md = formatRecommendations(result, populatedState, "md");
    expect(md).toContain("Showing 1 of 8 candidates.");
  });

  // ISS-1154: --with-actionability rendering
  describe("withActionability", () => {
    function actionableRec() {
      return {
        id: "T-001",
        kind: "ticket" as const,
        title: "Task",
        category: "quick_win" as const,
        reason: "Chore",
        score: 400,
        actionability: { status: "actionable" as const, reason: "open, no blocking signal", source: "ledger" as const },
      };
    }
    function excludedEntry(id: string) {
      return {
        id,
        kind: "issue" as const,
        title: "Duplicate bug",
        actionability: { status: "duplicate" as const, reason: "structured disposition: duplicate", source: "structured" as const },
      };
    }

    it("without the flag, markdown is byte-identical to the pre-ISS-1154 shape", () => {
      const result: RecommendResult = {
        recommendations: [actionableRec()],
        totalCandidates: 1,
        excludedCount: 2,
        excluded: [excludedEntry("ISS-001"), excludedEntry("ISS-002")],
        unreadableHandoverCount: 1,
      };
      const withoutFlag = formatRecommendations(result, populatedState, "md");
      const resultNoExtras: RecommendResult = { ...result, excludedCount: 0, excluded: [], unreadableHandoverCount: 0 };
      const baseline = formatRecommendations(resultNoExtras, populatedState, "md");
      expect(withoutFlag).toBe(baseline);
      expect(withoutFlag).not.toContain("actionability");
      expect(withoutFlag).not.toContain("Excluded");
    });

    it("appends the actionability suffix to each recommendation row", () => {
      const result: RecommendResult = {
        recommendations: [actionableRec()],
        totalCandidates: 1,
        excludedCount: 0,
        excluded: [],
        unreadableHandoverCount: 0,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).toContain("(actionable -- open, no blocking signal)");
    });

    it("Excluded section: exact-count header form (N === M)", () => {
      const result: RecommendResult = {
        recommendations: [actionableRec()],
        totalCandidates: 1,
        excludedCount: 2,
        excluded: [excludedEntry("ISS-001"), excludedEntry("ISS-002")],
        unreadableHandoverCount: 0,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).toContain("## Excluded (2)");
      expect(md).toContain("ISS-001: Duplicate bug (duplicate -- structured disposition: duplicate)");
      expect(md).toContain("ISS-002: Duplicate bug");
    });

    it("Excluded section: truncated header form (N !== M)", () => {
      const result: RecommendResult = {
        recommendations: [actionableRec()],
        totalCandidates: 1,
        excludedCount: 5,
        excluded: [excludedEntry("ISS-001")],
        unreadableHandoverCount: 0,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).toContain("## Excluded (5 total, showing 1)");
    });

    it("all-excluded response reaches the Excluded section instead of the terse empty string", () => {
      const result: RecommendResult = {
        recommendations: [],
        totalCandidates: 2,
        excludedCount: 2,
        excluded: [excludedEntry("ISS-001"), excludedEntry("ISS-002")],
        unreadableHandoverCount: 0,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).not.toContain("No recommendations");
      expect(md).toContain("## Excluded (2)");
    });

    it("window-incomplete warning: counted form (positive unreadableHandoverCount)", () => {
      const result: RecommendResult = {
        recommendations: [actionableRec()],
        totalCandidates: 1,
        excludedCount: 0,
        excluded: [],
        unreadableHandoverCount: 3,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).toContain("3 handover file(s) could not be read");
    });

    it("window-incomplete warning: count-free form (unreadableHandoverCount: null)", () => {
      const result: RecommendResult = {
        recommendations: [actionableRec()],
        totalCandidates: 1,
        excludedCount: 0,
        excluded: [],
        unreadableHandoverCount: null,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).toContain("handover history could not be listed");
    });

    it("an incomplete window alone (no excluded, empty recommendations) still reaches the warning, not the terse string", () => {
      const result: RecommendResult = {
        recommendations: [],
        totalCandidates: 0,
        excludedCount: 0,
        excluded: [],
        unreadableHandoverCount: null,
      };
      const md = formatRecommendations(result, populatedState, "md", true);
      expect(md).not.toContain("No recommendations");
      expect(md).toContain("handover history could not be listed");
    });
  });
});

// ISS-739 (GitHub #13): issue phase/location/order were settable via CLI/MCP
// but never rendered in markdown, and MCP read tools are hard-coded to md, so
// MCP clients could not see them at all.
describe("formatIssue phase/location/order (ISS-739)", () => {
  it("renders Phase and Order on the Status line, matching formatTicket placement", () => {
    const md = formatIssue(
      makeIssue({ id: "ISS-001", status: "open", severity: "high", phase: "p2", order: 3 }),
      "md",
    );
    expect(md).toContain("Status: open | Severity: high | Phase: p2 | Order: 3");
  });

  it("renders none defaults when phase and order are unset", () => {
    const md = formatIssue(makeIssue({ id: "ISS-001" }), "md");
    expect(md).toContain("Phase: none | Order: none");
  });

  it("renders Location when non-empty and omits the line when empty", () => {
    const withLoc = formatIssue(
      makeIssue({ id: "ISS-001", location: ["src/a.ts:10", "src/b.ts"] }),
      "md",
    );
    expect(withLoc).toContain("Location: src/a.ts:10, src/b.ts");
    const withoutLoc = formatIssue(makeIssue({ id: "ISS-002" }), "md");
    expect(withoutLoc).not.toContain("Location:");
  });

  it("formatIssueList rows carry the phase suffix like ticket rows", () => {
    const md = formatIssueList(
      [makeIssue({ id: "ISS-001", phase: "p1" }), makeIssue({ id: "ISS-002" })],
      "md",
    );
    expect(md).toContain("ISS-001 [medium]: Test ISS-001 (p1)");
    expect(md).toContain("ISS-002 [medium]: Test ISS-002 (none)");
  });
});

describe("session rows carry UNTRUSTED content (ISS-897)", () => {
  // `state` is deliberately a free string (T-328): a newer workflow state must
  // not brick an older reader. Every one of these fields reaches the operator
  // through Markdown, and every one of them is read out of a state.json this
  // build did not write -- so schema-valid does not mean safe to print. A
  // control character reaching a terminal can redraw the line it sits on, and
  // Markdown metacharacters can restyle the surrounding output; the row that
  // announces a session must not be forgeable by the session it announces.
  const ESC = "\u001b";
  const hostile = {
    // A CSI erase-line sequence: a terminal that receives it raw wipes the row
    // it is printed on.
    sessionId: `${ESC}[2Kaaaa1111-2222`,
    sourceDir: "sess",
    state: `IMPLEMENT${ESC}[31m`,
    // A CR redraws the row without ending it.
    mode: "auto\r  ",
    ticketId: "T-001",
    // Three ways to forge a ROW: a newline; U+2028, which is not a C0 control
    // character but IS a line break to many renderers; and a bidi override,
    // which reorders what the reader SEES without changing a byte -- so a row
    // can name one session and appear to name another.
    ticketTitle: "Title\n- FORGED: nothing -- COMPLETE (auto mode)\u2028also forged\u202eeltiT",
  };

  // Every field is schema-valid: strings where strings belong. Nothing here is
  // malformed, which is exactly why the guard's shape checks cannot catch it.
  //
  // Two bars, and the second one moved. Forging a ROW must be impossible,
  // because these rows are the operator's evidence about which sessions exist.
  // Authoring inline STRUCTURE must now be impossible too.
  //
  // That second bar is new. This is not a terminal-only sink: `storybloq_status`
  // defaults to `format: "md"` and hands that text to an MCP client, which may
  // render it. Session-sourced fields therefore take `escapeMarkdownDocumentStrict`
  // -- links, elements, code spans, emphasis, bare URLs and `@` mentions all
  // inert. The ledger-sourced fields on the same document (phase names, ticket
  // titles, issue titles) still take the inline pass, and that boundary is
  // ISS-915's: a different source, a different set of callers.
  //
  // The earlier reasoning here -- that switching the session rows alone would
  // leave one field on a document escaped and the field beside it not, which is
  // worse than either consistent answer -- was what kept this open. It was
  // wrong about which inconsistency mattered: `sessionDiagnosticLines`, in this
  // same file, already escapes strictly, and its values come out of the SAME
  // `state.json` files. One document neutralizing a directory name while
  // leaving the ticket title beside it live is the inconsistency that counts.
  function assertClean(
    md: string,
    label: string,
    opts: { rendersState?: boolean; rendersTicket?: boolean } = {},
  ) {
    for (const [name, ch] of [
      ["ESC", ESC],
      ["CR", "\r"],
      ["LF", "\n- FORGED"],
      ["U+2028", "\u2028"],
      ["bidi override", "\u202e"],
    ] as const) {
      expect(md, `${label}: raw ${name}`).not.toContain(ch);
    }
    // Exactly one row per session, whatever the payload tried to append.
    expect(md.split("\n").filter((l) => l.startsWith("- ")), `${label}: forged row`).toHaveLength(1);
    // ...and the row is still useful: neutering must not blank the fields an
    // operator identifies the session by.
    // The ticket label is the identifying field on rows that have one. The
    // short-id fallback rows deliberately have none, which is the whole reason
    // they exercise a different branch.
    if (opts.rendersTicket !== false) expect(md, `${label}: ticket lost`).toContain("T-001");
    // Resumable rows announce recovery instead of a workflow state, so only the
    // active rows are asked to have kept it.
    if (opts.rendersState !== false) expect(md, `${label}: state lost`).toContain("IMPLEMENT");
  }

  const state = makeState();

  it("neutralizes them in ACTIVE rows of standard status", () => {
    assertClean(formatStatus(state, "md", [hostile], []), "active");
  });

  it("neutralizes them in RESUMABLE rows of standard status", () => {
    // A different code path with a different fallback (`session <shortId>`
    // instead of `no ticket`), so it needs its own row -- and the shortId is a
    // `slice(0, 8)` of untrusted text, which is a raw substring unless it is
    // sanitized too.
    assertClean(formatStatus(state, "md", [], [{ ...hostile, leaseState: "expired" }]), "resumable", {
      rendersState: false,
    });
  });

  const emptyFederation = {
    orchestratorProject: "orchestrator",
    nodeCount: 0,
    reachableCount: 0,
    unreachableCount: 0,
    nodes: [],
    totalTickets: 0,
    totalOpenTickets: 0,
    totalCompleteTickets: 0,
    totalIssues: 0,
    totalOpenIssues: 0,
    lastScanTimestamp: "2026-01-01T00:00:00.000Z",
  };

  it.each([
    ["standard", (rows: unknown[]) => formatStatus(state, "md", [], rows as never)],
    [
      "federated",
      (rows: unknown[]) =>
        formatFederatedStatus(emptyFederation as never, state.config, "md", [], rows as never),
    ],
  ])("neutralizes the resumable SHORT-ID fallback too (%s)", (label, render) => {
    // The row above carries `ticketId: "T-001"`, so it renders the ticket label
    // and never reaches the other branch. That branch is `session ${shortId}`,
    // where `shortId` is a `slice(0, 8)` of the untrusted `sessionId` -- a raw
    // substring unless it is sanitized on this path too. With a ticket always
    // present, the ESC assertions passed over a fallback that was never run.
    const noTicket = {
      ...hostile,
      leaseState: "expired",
      ticketId: null,
      ticketTitle: null,
    };
    const md = render([noTicket]);
    assertClean(md, `${label} short-id`, { rendersState: false, rendersTicket: false });
    // The fallback actually RAN -- otherwise this test would pass by rendering
    // nothing at all -- and what it printed is the sanitized short id.
    // The `[` arrives ESCAPED: this is a Markdown document, and a short id is
    // a raw substring of an untrusted `sessionId`.
    expect(md, `${label}: short-id fallback not reached`).toContain("session ?\\[2Kaaa");
  });

  it("does not split an ASTRAL character when building the short id", () => {
    // `sanitizeDisplayText` is careful not to leave a lone surrogate, and this
    // `slice(0, 8)` immediately could: an id whose eighth UTF-16 unit lands
    // inside an astral character keeps the high surrogate and drops the low
    // one. A terminal draws that as the replacement glyph, so two different
    // sessions can produce the same short id -- on the resumable rows an
    // operator reads to tell them apart.
    const EMOJI = "\u{1f600}";
    const md = formatStatus(state, "md", [], [
      {
        ...hostile,
        leaseState: "expired",
        ticketId: null,
        ticketTitle: null,
        sessionId: `sevench${EMOJI}rest`,
      },
    ] as never);

    for (let i = 0; i < md.length; i += 1) {
      const c = md.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = md.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${i}`).toBe(true);
        i += 1;
      } else {
        expect(c >= 0xdc00 && c <= 0xdfff, `lone low surrogate at ${i}`).toBe(false);
      }
    }
    // The fallback ran AND kept the boundary character whole. Asserting only
    // the seven-character prefix would pass an implementation that simply
    // dropped the emoji -- which is the collision this test exists to prevent,
    // not a fix for it.
    expect(md).toContain(`session sevench${EMOJI}`);

    // ...and two ids differing only at that boundary still render as two short
    // ids. This is the property the surrogate check above cannot establish on
    // its own: absence of a lone surrogate says the output is well formed, not
    // that it is still distinguishing sessions.
    const other = formatStatus(state, "md", [], [
      {
        ...hostile,
        leaseState: "expired",
        ticketId: null,
        ticketTitle: null,
        sessionId: `sevench${"\u{1f601}"}rest`,
      },
    ] as never);
    const shortOf = (text: string): string => /session (sevench.)/u.exec(text)?.[1] ?? "";
    expect(shortOf(md), "short id not found").not.toBe("");
    expect(shortOf(md)).not.toBe(shortOf(other));
  });

  it.each([
    ["standard", (rows: unknown[]) => formatStatus(state, "md", rows as never, [])],
    [
      "federated",
      (rows: unknown[]) =>
        formatFederatedStatus(emptyFederation as never, state.config, "md", rows as never, []),
    ],
  ])("still cannot forge a ROW out of inline Markdown or HTML (%s)", (label, render) => {
    // Two claims, and this used to make only the weaker one. The non-JSON
    // branch of both formatters emits a Markdown DOCUMENT -- `#` headings,
    // `**bold**` -- and every field on a session row is read back out of a
    // `state.json`, so inline structure surviving here is a live link in the
    // status output an operator reads during an incident, not a cosmetic
    // artifact. It is neutralized now, and the text is still legible.
    const markdownish = {
      ...hostile,
      ticketTitle:
        "[click](https://elsewhere.example) <img src=x> `code` **bold** @admin | piped\u2028second",
    };
    const md = render([markdownish]);

    // One row, whatever the payload tried to append.
    expect(md.split("\n").filter((l) => l.startsWith("- ")), `${label}: forged row`).toHaveLength(1);
    // The line-break-shaped characters are still gone, which is what forging a
    // row actually requires.
    expect(md, `${label}: raw U+2028`).not.toContain("\u2028");
    expect(md, `${label}: raw LF in title`).not.toContain("piped\n");
    // ...and the text is preserved rather than dropped, so an operator can see
    // exactly what the session claimed its ticket was called.
    expect(md).toContain("elsewhere.example");
    expect(md).toContain("bold");
    // ...and no inline structure survives to be RENDERED. The link wrapper is
    // dead, the element is dead, the code span is dead, the emphasis is dead.
    expect(md, "live link wrapper").not.toContain("[click](");
    expect(md, "live element").not.toContain("<img");
    expect(md, "live code span").not.toContain("`code`");
    expect(md, "live emphasis").not.toContain("**bold");
    // The two forms that need no wrapper at all, and that `escapeMarkdownDocument`
    // (the non-strict pass) leaves alone: a bare URL autolinks by itself, and
    // `@admin` is a live mention on the surfaces that render this. Without
    // these, the suite would still pass on the weaker pass.
    expect(md, "bare URL autolinks").not.toContain("https://elsewhere.example");
    expect(md, "live mention").not.toContain("@admin");
    // ...while both remain LEGIBLE, which is the point of escaping rather than
    // stripping.
    expect(md).toContain("elsewhere.example");
    expect(md).toContain("admin");
    // The escaped forms are what is there instead, so this is neutralization
    // rather than the payload having been dropped on the floor.
    expect(md, "escaped bracket").toContain("\\[click\\]");
  });

  it("neutralizes them in BOTH populations of federated status", () => {
    // The federated formatter renders its own session rows. It was the seam
    // that kept the raw values after the standard one was fixed, because the
    // two share `safeSessionFields` but build and emit their rows separately.
    const fed = {
      orchestratorProject: "orch",
      nodeCount: 0,
      reachableCount: 0,
      unreachableCount: 0,
      nodes: [],
      totalTickets: 0,
      totalOpenTickets: 0,
      totalCompleteTickets: 0,
      totalIssues: 0,
      totalOpenIssues: 0,
      lastScanTimestamp: "2026-01-01T00:00:00.000Z",
    };
    assertClean(formatFederatedStatus(fed, state.config, "md", [hostile], []), "federated active");
    assertClean(
      formatFederatedStatus(fed, state.config, "md", [], [{ ...hostile, leaseState: "expired" }]),
      "federated resumable",
      { rendersState: false },
    );
  });

  it("leaves BOTH JSON payload values unmodified -- escaping there would corrupt them", () => {
    // Markdown escaping is a rendering concern. A consumer parsing the JSON
    // needs the decoded input values unmodified by this formatter, and `JSON.stringify` already
    // encodes control characters so they cannot escape the string.
    //
    // Asserting that ESC appears encoded is not enough: it would still pass if
    // the formatter had quietly sanitized the newline, the CR, U+2028 or the
    // bidi override, since the check names only one of the five. Compare the
    // whole object instead, and do it for the federated payload too -- it is a
    // separate implementation, which is exactly why the Markdown fix had to be
    // made twice.
    const fed = {
      orchestratorProject: "orch",
      nodeCount: 0,
      reachableCount: 0,
      unreachableCount: 0,
      nodes: [],
      totalTickets: 0,
      totalOpenTickets: 0,
      totalCompleteTickets: 0,
      totalIssues: 0,
      totalOpenIssues: 0,
      lastScanTimestamp: "2026-01-01T00:00:00.000Z",
    };
    for (const [label, json] of [
      ["standard", formatStatus(state, "json", [hostile], [])],
      ["federated", formatFederatedStatus(fed, state.config, "json", [hostile], [])],
    ] as const) {
      const parsed = JSON.parse(json) as { data: { activeSessions: unknown[] } };
      expect(parsed.data.activeSessions, label).toEqual([hostile]);
    }
  });

  describe("expiredLeaseSessions (ISS-943)", () => {
    const fed = {
      orchestratorProject: "orch",
      nodeCount: 0,
      reachableCount: 0,
      unreachableCount: 0,
      nodes: [],
      totalTickets: 0,
      totalOpenTickets: 0,
      totalCompleteTickets: 0,
      totalIssues: 0,
      totalOpenIssues: 0,
      lastScanTimestamp: "2026-01-01T00:00:00.000Z",
    };

    it.each([
      ["standard", (rows: unknown[]) => formatStatus(state, "md", [], [], undefined, [], undefined, rows as never)],
      [
        "federated",
        (rows: unknown[]) =>
          formatFederatedStatus(fed as never, state.config, "md", [], [], undefined, [], undefined, rows as never),
      ],
    ])("neutralizes hostile fields in the Expired-Lease Sessions rows (%s)", (label, render) => {
      assertClean(render([hostile]), `${label} expired-lease`);
    });

    it.each([
      ["standard", (rows: unknown[]) => formatStatus(state, "json", [], [], undefined, [], undefined, rows as never)],
      [
        "federated",
        (rows: unknown[]) =>
          formatFederatedStatus(fed as never, state.config, "json", [], [], undefined, [], undefined, rows as never),
      ],
    ])("empty-vs-non-empty JSON contract: field always present, unmodified when supplied (%s)", (label, render) => {
      const empty = JSON.parse(render([])) as { data: { expiredLeaseSessions: unknown[] } };
      expect(empty.data.expiredLeaseSessions, `${label}: empty`).toEqual([]);
      const nonEmpty = JSON.parse(render([hostile])) as { data: { expiredLeaseSessions: unknown[] } };
      // JSON is not a Markdown sink -- the raw value survives unmodified, same
      // as `activeSessions`/`resumableSessions` above.
      expect(nonEmpty.data.expiredLeaseSessions, `${label}: non-empty`).toEqual([hostile]);
    });
  });
});

describe("formatStatus positional compatibility (ISS-943, Codex round 4)", () => {
  // `formatStatus` is positional and re-exported from the package root
  // (`core/index.ts` -> `src/index.ts`), so an external caller may still be
  // invoking it with the pre-ISS-943 argument count. Appending
  // `expiredLeaseSessions` LAST must leave that shape byte-identical.
  it("an existing-shape positional call omitting the new final argument is unaffected", () => {
    const state = makeState();
    const bus = { enabled: true, error: undefined } as never;
    const limitStops = [
      {
        key: "k1",
        sessionType: "autonomous",
        storybloqSessionId: "sess-1",
        clientTaskId: "task-1",
        status: "deferred",
        limitType: "usage",
        reasonCode: null,
        mode: "headless",
        nextAttemptAt: "2026-01-01T00:00:00.000Z",
        wakeAttempts: 1,
      },
    ] as never;
    const diagnostics = [
      {
        kind: "state-unreadable",
        category: "omission",
        sourceDir: "broken",
        sourcePath: "/p/.story/sessions/broken/state.json",
        sessionId: null,
        reason: "unreadable",
      },
    ] as never;

    const withoutNewArg = formatStatus(state, "json", [], [], bus, limitStops, diagnostics);
    const withExplicitEmptyNewArg = formatStatus(state, "json", [], [], bus, limitStops, diagnostics, []);

    // Byte-identical: the appended parameter defaults to `[]`, so omitting it
    // is indistinguishable from passing an empty array explicitly, and every
    // pre-existing field (bus, sessionDiagnostics) is unaffected. T-534: the
    // limit-stop slot is kept and ignored, so sessionDiagnostics still lands.
    expect(withoutNewArg).toBe(withExplicitEmptyNewArg);
    const parsed = JSON.parse(withoutNewArg) as {
      data: { expiredLeaseSessions: unknown[]; bus: unknown; sessionDiagnostics: unknown[] } & Record<string, unknown>;
    };
    expect(parsed.data.expiredLeaseSessions).toEqual([]);
    expect("limitStops" in parsed.data).toBe(false);
    expect(parsed.data.sessionDiagnostics).toEqual(diagnostics);
    expect(parsed.data.bus).toEqual(bus);
  });
});

/**
 * T-320 commit 3: `compact` is an additive, APPENDED-LAST boolean, same
 * discipline as `expiredLeaseSessions` (ISS-943) and `arrangements` (T-473)
 * before it. Omitting it (or passing `false`) must leave every existing
 * caller byte-identical; the reduction only happens when it is explicitly
 * `true`, and it renders JSON regardless of the `format` argument -- the
 * ticket's amendment states compact status is JSON only, so there is no
 * markdown compact form to keep in sync.
 */
describe("formatStatus compact mode (T-320 commit 3)", () => {
  it("omitting compact (or passing false) is byte-identical to the pre-existing shape", () => {
    const state = makeState();
    const bare = formatStatus(state, "json");
    const explicitFalse = formatStatus(
      state,
      "json",
      [],
      [],
      undefined,
      [],
      undefined,
      [],
      { items: [], warnings: [] },
      false,
    );
    expect(bare).toBe(explicitFalse);
  });

  it("compact:true renders JSON even when format is md", () => {
    const state = makeState();
    const out = formatStatus(state, "md", [], [], undefined, [], undefined, [], undefined, true);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("compact:true drops archivedNotes, deprecatedLessons, and issueFlow.semantics", () => {
    const state = makeState({
      notes: [makeNote({ id: "N-1", status: "archived" })],
      lessons: [makeLesson({ id: "L-1", status: "deprecated" })],
      issues: [makeIssue({ id: "ISS-1", discoveredDate: "2026-01-01" })],
    });
    const parsed = JSON.parse(
      formatStatus(state, "json", [], [], undefined, [], undefined, [], undefined, true),
    ) as { data: Record<string, unknown> };
    expect(parsed.data.archivedNotes).toBeUndefined();
    expect(parsed.data.deprecatedLessons).toBeUndefined();
    expect(parsed.data.activeNotes).toBe(0);
    const issueFlow = parsed.data.issueFlow as { semantics?: unknown } | null;
    if (issueFlow) expect(issueFlow.semantics).toBeUndefined();
  });

  it("compact:true reduces session entries to the eight-field set, dropping ticketId/ticketTitle", () => {
    const state = makeState();
    const session = {
      sessionId: "sess-1",
      sourceDir: "sess-1",
      state: "active",
      mode: "autonomous",
      ticketId: "T-1",
      ticketTitle: "Some ticket",
      ownerTask: null,
      leaseExpiresAt: null,
      leaseState: "live",
      compactPending: false,
    } as never;
    const parsed = JSON.parse(
      formatStatus(state, "json", [session], [], undefined, [], undefined, [], undefined, true),
    ) as { data: { activeSessions: Record<string, unknown>[] } };
    const s = parsed.data.activeSessions[0]!;
    expect(s.ticketId).toBeUndefined();
    expect(s.ticketTitle).toBeUndefined();
    expect(s).toMatchObject({
      sessionId: "sess-1",
      sourceDir: "sess-1",
      state: "active",
      mode: "autonomous",
      leaseState: "live",
      compactPending: false,
    });
  });

  it("compact:true reduces bus to six fields, dropping participants/wake/hookDelivery/deliveryCapabilities", () => {
    const state = makeState();
    const bus = {
      enabled: true,
      initialized: true,
      daemonState: "stopped",
      setupState: "ready",
      deliveryMode: "live",
      participants: [{ id: "p1" }],
      nextActions: ["do a thing"],
      endpoints: 2,
      pendingMessages: 3,
      unacknowledgedCritical: 1,
      openThreads: 0,
      parkedThreads: 0,
      undeliverable: 0,
      quarantined: 0,
      hookDelivery: { claude: true, codex: false },
      deliveryCapabilities: {},
      wake: {},
    } as never;
    const parsed = JSON.parse(
      formatStatus(state, "json", [], [], bus, [], undefined, [], undefined, true),
    ) as { data: { bus: Record<string, unknown> } };
    expect(parsed.data.bus).toEqual({
      enabled: true,
      daemonState: "stopped",
      deliveryMode: "live",
      pendingMessages: 3,
      unacknowledgedCritical: 1,
      nextActions: ["do a thing"],
    });
  });

  it("compact:true carries no limitStops and ignores the retained slot (T-534)", () => {
    const state = makeState();
    const parsed = JSON.parse(
      formatStatus(state, "json", [], [], undefined, [{ key: "k1" }], undefined, [], undefined, true),
    ) as { data: Record<string, unknown> };
    expect("limitStops" in parsed.data).toBe(false);
  });

  it("compact:true keeps sessionDiagnostics and arrangements/arrangementWarnings unreduced", () => {
    const state = makeState();
    const diagnostics = [
      {
        kind: "state-unreadable",
        category: "omission",
        sourceDir: "broken",
        sourcePath: "/p/.story/sessions/broken/state.json",
        sessionId: null,
        reason: "unreadable",
      },
    ] as never;
    const arrangements = {
      items: [{ route: null, id: "a-1", lifecycle: "active", bounds: ["T-1"], parties: [] }],
      warnings: ["an advisory warning"],
    } as never;
    const parsed = JSON.parse(
      formatStatus(state, "json", [], [], undefined, [], diagnostics, [], arrangements, true),
    ) as { data: { sessionDiagnostics: unknown[]; arrangements: unknown[]; arrangementWarnings: unknown[] } };
    expect(parsed.data.sessionDiagnostics).toEqual(diagnostics);
    expect(parsed.data.arrangements).toEqual(arrangements.items);
    expect(parsed.data.arrangementWarnings).toEqual(arrangements.warnings);
  });
});

/**
 * T-476 binding ruling, closed structurally per the pen's round-3 acceptor's
 * ruling: the anti-laundering caveat was found missing three separate times
 * across three separate review rounds (formatRuling's JSON chainStatus-less
 * branch, formatRulingList, and the create/supersede result JSON) -- three
 * per-surface fixes losing to surface growth. This test enumerates every
 * exported `formatRuling*` function BY REFLECTION (not a hand-maintained
 * list a new formatter could silently skip) and asserts that any output
 * surface displaying `attribution`/`recordedBy` also carries the caveat --
 * mirroring array-options.e2e.test.ts's coverage-matrix pattern, so a new
 * formatter without a matching ADAPTERS entry fails the coverage test below
 * before it can ever ship without the caveat.
 */
describe("T-476 binding ruling: every attribution-displaying ruling formatter output carries the anti-laundering caveat (round-3 self-audit)", () => {
  const sampleRuling: Ruling = {
    id: "r-0000000000000abc",
    text: "Sample ruling text for the self-audit fixture.",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "self-audit-session" },
    date: "2026-08-28",
    scopeTags: [],
    supersedes: null,
  };

  interface FormatterOutput {
    readonly label: string;
    readonly output: string;
    /** Whether THIS specific output surface displays attribution/recordedBy at all. */
    readonly showsAttribution: boolean;
  }

  const ADAPTERS: Record<string, () => FormatterOutput[]> = {
    formatRuling: () => [
      { label: "md", output: outputFormatter.formatRuling(sampleRuling, "md"), showsAttribution: true },
      { label: "json", output: outputFormatter.formatRuling(sampleRuling, "json"), showsAttribution: true },
    ],
    formatRulingList: () => [
      { label: "md", output: outputFormatter.formatRulingList([sampleRuling], "md"), showsAttribution: true },
      { label: "json", output: outputFormatter.formatRulingList([sampleRuling], "json"), showsAttribution: true },
    ],
    formatRulingCreateResult: () => [
      // The markdown branch is a terse confirmation ("Created ruling X.")
      // that never displays attribution/recordedBy at all -- the caveat
      // guards against a shown claim being mistaken for a verified one, so
      // it has nothing to guard here. The JSON branch spreads the full
      // ruling (including attribution) and DOES need it.
      { label: "md", output: outputFormatter.formatRulingCreateResult(sampleRuling, "md"), showsAttribution: false },
      { label: "json", output: outputFormatter.formatRulingCreateResult(sampleRuling, "json"), showsAttribution: true },
    ],
    formatRulingSupersedeResult: () => [
      { label: "md", output: outputFormatter.formatRulingSupersedeResult(sampleRuling, false, "md"), showsAttribution: false },
      { label: "json", output: outputFormatter.formatRulingSupersedeResult(sampleRuling, false, "json"), showsAttribution: true },
    ],
    // T-522: the lifecycle write results. Their md forms name the id only.
    formatRulingProposeResult: () => [
      { label: "md", output: outputFormatter.formatRulingProposeResult(sampleRuling, "md"), showsAttribution: false },
      { label: "json", output: outputFormatter.formatRulingProposeResult(sampleRuling, "json"), showsAttribution: true },
    ],
    formatRulingAcceptResult: () => [
      { label: "md", output: outputFormatter.formatRulingAcceptResult(sampleRuling, false, "md"), showsAttribution: false },
      { label: "json", output: outputFormatter.formatRulingAcceptResult(sampleRuling, false, "json"), showsAttribution: true },
    ],
    formatRulingWithdrawResult: () => [
      { label: "md", output: outputFormatter.formatRulingWithdrawResult(sampleRuling, "md"), showsAttribution: false },
      { label: "json", output: outputFormatter.formatRulingWithdrawResult(sampleRuling, "json"), showsAttribution: true },
    ],
  };

  it("covers every exported formatRuling* function -- a new one with no adapter here fails loudly", () => {
    const discovered = Object.keys(outputFormatter).filter((k) => k.startsWith("formatRuling")).sort();
    expect(discovered).toEqual(Object.keys(ADAPTERS).sort());
  });

  it("every attribution-displaying output carries the anti-laundering caveat text", () => {
    for (const [name, produce] of Object.entries(ADAPTERS)) {
      for (const { label, output, showsAttribution } of produce()) {
        if (!showsAttribution) continue;
        expect(output, `${name} (${label}) shows attribution but is missing the anti-laundering caveat`).toMatch(
          /not verified by storybloq/i,
        );
      }
    }
  });
});

/**
 * ISS-1214: a handover whose stamp did not land used to return exactly
 * "Created handover: <file>", so an agent read the reply as success while the
 * presence record kept `handoverWrittenAt: null` and the prompt hook re-fired
 * the imperative two prompts later with no visible cause.
 */
describe("ISS-1214: formatHandoverCreateResult names why an attempted stamp did not land", () => {
  const FILE = "2026-09-14-01-session.md";
  const HINT = "Also: the server binary is stale; a restart loads the new build but does not fix the binding.";
  const NEUTRAL = "The caller could not be bound to a live presence record.";
  const busy = { reason: "lock busy", kind: "outcome" } as const;
  const unbound = { reason: "skipped: no presence record for the caller", kind: "binding" } as const;

  it("md: the bare reply is unchanged when there is no failure, and a failure adds one block under it", () => {
    expect(outputFormatter.formatHandoverCreateResult(FILE, "md")).toBe(`Created handover: ${FILE}`);
    expect(outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, null)).toBe(`Created handover: ${FILE}`);
    expect(outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, busy)).toBe(
      `Created handover: ${FILE}\n\nHandover stamp did not land (lock busy). The pressure line repeats at most once every 10 minutes.`,
    );
  });

  it("md: the causal restart hint requires POSITIVE staleness; an unbound caller on a fresh server gets the neutral sentence", () => {
    const fresh = outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, unbound, false);
    expect(fresh).toContain("Handover stamp did not land (skipped: no presence record for the caller). The pressure line repeats at most once every 10 minutes.");
    expect(fresh).toContain(NEUTRAL);
    expect(fresh).not.toContain(HINT);

    const stale = outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, unbound, true);
    expect(stale).toContain(HINT);
    expect(stale).not.toContain(NEUTRAL);

    // Default is false: a caller that cannot establish staleness never asserts it.
    expect(outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, unbound)).toContain(NEUTRAL);
  });

  it("md: outcome, refused and error kinds get neither sentence, stale or not", () => {
    for (const kind of ["outcome", "refused", "error"] as const) {
      for (const stale of [false, true]) {
        const out = outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, { reason: `r-${kind}`, kind }, stale);
        expect(out, `${kind}/${String(stale)}`).toBe(
          `Created handover: ${FILE}\n\nHandover stamp did not land (r-${kind}). The pressure line repeats at most once every 10 minutes.`,
        );
      }
    }
  });

  it("json: tokenPressureStampReason carries the reason, and the key is absent when there is none", () => {
    const withReason = JSON.parse(outputFormatter.formatHandoverCreateResult(FILE, "json", false, null, null, false, busy)) as { data: Record<string, unknown> };
    expect(withReason.data).toEqual({ filename: FILE, tokenPressureStampReason: "lock busy" });
    const none = JSON.parse(outputFormatter.formatHandoverCreateResult(FILE, "json", false, null, null, false, null)) as { data: Record<string, unknown> };
    expect(none.data).toEqual({ filename: FILE });
    const landed = JSON.parse(outputFormatter.formatHandoverCreateResult(FILE, "json", true)) as { data: Record<string, unknown> };
    expect(landed.data).toEqual({ filename: FILE, tokenPressureStamped: true });
  });
});

describe("ISS-1263: the reply quotes the configured re-arm interval exactly", () => {
  const FILE = "2026-09-24-01-session.md";
  const busy = { reason: "lock busy", kind: "outcome" } as const;
  const acked = (ms: number) => outputFormatter.formatHandoverCreateResult(FILE, "md", true, null, null, false, null, false, "unbound-era", ms);
  const failed = (ms: number) => outputFormatter.formatHandoverCreateResult(FILE, "md", false, null, null, false, busy, false, "bound", ms);

  it("whole minutes, whole seconds and milliseconds are each rendered without rounding", () => {
    expect(acked(600_000)).toBe(`Created handover: ${FILE}\n\nHandover recorded at ${FILE}. The pressure line will not repeat for 10 minutes.`);
    expect(acked(60_000)).toMatch(/will not repeat for 1 minute\.$/);
    expect(acked(90_000)).toMatch(/will not repeat for 90 seconds\.$/);
    expect(acked(1_500)).toMatch(/will not repeat for 1500 milliseconds\.$/);
    expect(failed(90_000)).toMatch(/\(lock busy\)\. The pressure line repeats at most once every 90 seconds\.$/);
  });

  it("an interval of zero promises no hold at all", () => {
    expect(acked(0)).toBe(`Created handover: ${FILE}\n\nHandover recorded at ${FILE}. The pressure line has no minimum repeat interval (handoverRearmIntervalMs is 0).`);
    expect(failed(0)).toMatch(/\(lock busy\)\. The pressure line has no minimum repeat interval \(handoverRearmIntervalMs is 0\)\.$/);
    expect(acked(0)).not.toMatch(/minute|will not repeat/);
  });
});

describe("ISS-1219: trajectory zero-count rendering", () => {
  // occurrenceCount counts only continuation/blocked/owner-gated/carried
  // mentions (buildTrajectory); latest takes any mention. A shipped-only id
  // therefore has count 0 beside a named latest, and the single-sentence
  // form read as a contradiction in the field (ISS-1210, 2026-09-14).
  const zeroShipped = {
    id: "ISS-1210",
    occurrenceCount: 0,
    firstSeenInWindow: "h1.md",
    latest: "h1.md",
    latestDisposition: "shipped" as const,
  };
  const twoContinuation = {
    id: "ISS-950",
    occurrenceCount: 2,
    firstSeenInWindow: "h2.md",
    latest: "h1.md",
    latestDisposition: "continuation" as const,
  };
  // Synthetic: the count rule never produces a zero-count entry with a
  // non-shipped disposition today; this fixture pins that the renderer
  // reads the disposition from data rather than hardcoding "shipped".
  const zeroContinuation = {
    id: "T-999",
    occurrenceCount: 0,
    firstSeenInWindow: "h1.md",
    latest: "h1.md",
    latestDisposition: "continuation" as const,
  };
  const brief = (trajectory: TrajectoryEntry[]) => ({
    handovers: [{ filename: "h1.md", form: "structured" as const, records: [], index: null }],
    trajectory,
    skippedHandovers: 0,
    missingHandovers: 0,
  });

  it("renders a zero-count entry as a no-open-mention line, never as 'seen in 0'", () => {
    const md = outputFormatter.formatHandoverBrief(brief([zeroShipped, twoContinuation]), "md");
    expect(md).toContain("- ISS-1210: no open mention; last named as shipped in h1.md");
    expect(md).not.toMatch(/seen in 0 handover\(s\), latest/);
    expect(md).toContain("- ISS-950: seen in 2 handover(s), latest h1.md (continuation)");
  });

  it("takes the disposition from the entry, not a literal 'shipped'", () => {
    const md = outputFormatter.formatHandoverBrief(brief([zeroContinuation]), "md");
    expect(md).toContain("- T-999: no open mention; last named as continuation in h1.md");
  });

  it("leaves the json trajectory shape unchanged", () => {
    const json = JSON.parse(outputFormatter.formatHandoverBrief(brief([zeroShipped, twoContinuation]), "json")) as {
      data: { trajectory: { id: string; occurrenceCount: number }[] };
    };
    expect(json.data.trajectory.map((t) => [t.id, t.occurrenceCount])).toEqual([
      ["ISS-1210", 0],
      ["ISS-950", 2],
    ]);
  });
});

describe("T-522: formatProposalsSectionBounded is bounded on both axes", () => {
  const sampleRulingForCompat: Ruling = {
    id: "r-0000000000000001", text: "legacy", attribution: "owner-direct",
    recordedBy: { client: "claude", id: "t" }, date: "2026-01-01", scopeTags: [], supersedes: null,
  };
  const proposal = (i: number, text: string): Ruling => ({
    id: `r-${String(i).padStart(16, "0")}`,
    text,
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "t" },
    date: "2026-09-22",
    scopeTags: [],
    supersedes: null,
    status: "proposed",
    proposesToSupersede: null,
    proposedFor: ["T-001"],
  } as Ruling);

  it("names at most PROPOSALS_MAX entries even under an unlimited text budget", () => {
    const out = outputFormatter.formatProposalsSectionBounded([1, 2, 3, 4, 5, 6, 7].map((i) => proposal(i, "short")), Number.MAX_SAFE_INTEGER);
    expect((out.text.match(/^- \*\*r-/gm) ?? []).length).toBe(outputFormatter.PROPOSALS_MAX);
    expect(out.omittedIds).toEqual([proposal(6, "").id, proposal(7, "").id]);
  });

  it("the complete returned block never exceeds the budget: header counted, exact fit kept, one byte less omits", () => {
    const three = [1, 2, 3].map((i) => proposal(i, "x".repeat(240)));
    const oneEntry = outputFormatter.formatProposalsSectionBounded([three[0]!], Number.MAX_SAFE_INTEGER).text;
    const exact = outputFormatter.formatProposalsSectionBounded(three, oneEntry.length);
    expect(exact.text).toBe(oneEntry);
    expect(exact.text.length).toBeLessThanOrEqual(oneEntry.length);
    expect(exact.omittedIds).toEqual([three[1]!.id, three[2]!.id]);
    const under = outputFormatter.formatProposalsSectionBounded(three, oneEntry.length - 1);
    expect(under.text).toBe("");
    expect(under.omittedIds).toHaveLength(3);
    const twoEntries = outputFormatter.formatProposalsSectionBounded(three.slice(0, 2), Number.MAX_SAFE_INTEGER).text;
    const two = outputFormatter.formatProposalsSectionBounded(three, twoEntries.length);
    expect(two.text).toBe(twoEntries);
    expect(two.omittedIds).toEqual([three[2]!.id]);
    for (const budget of [0, 10, 100, 400, 700, 1000]) {
      expect(outputFormatter.formatProposalsSectionBounded(three, budget).text.length).toBeLessThanOrEqual(budget);
    }
  });

  it("shows a proposal's text whole or not at all: never sliced, never narrative", () => {
    const long = proposal(1, "a".repeat(5000) + " END");
    const p = { ...long, narrative: { context: "SECRET-NARRATIVE" } } as Ruling;
    const shown = outputFormatter.formatProposalsSectionBounded([p], Number.MAX_SAFE_INTEGER);
    expect(shown.text).toContain("a".repeat(5000) + " END");
    expect(shown.text).not.toContain("...");
    expect(shown.text).not.toContain("SECRET-NARRATIVE");
    const hidden = outputFormatter.formatProposalsSectionBounded([p], 3000);
    expect(hidden.text).toBe("");
    expect(hidden.omittedIds).toEqual([p.id]);
  });

  it("formatRuling without extras renders as before T-522: no lifecycle, no revision, no narrative", () => {
    const withNarrative = { ...sampleRulingForCompat, narrative: { context: "NARR-CTX" } } as Ruling;
    expect(outputFormatter.formatRuling(withNarrative, "md")).toBe(outputFormatter.formatRuling(sampleRulingForCompat, "md"));
    expect(outputFormatter.formatRuling(withNarrative, "md")).not.toContain("NARR-CTX");
    expect(outputFormatter.formatRuling(withNarrative, "md", undefined, { lifecycle: "accepted-legacy" })).toContain("- context: NARR-CTX");
    const md = outputFormatter.formatRuling(sampleRulingForCompat, "md");
    expect(md).not.toContain("Revision:");
    expect(md).not.toMatch(/^# Ruling r-[0-9a-f]+ \[/m);
    const json = JSON.parse(outputFormatter.formatRuling(sampleRulingForCompat, "json")).data;
    expect(json).not.toHaveProperty("revision");
    expect(json).not.toHaveProperty("lifecycle");
    const withLc = JSON.parse(outputFormatter.formatRuling(sampleRulingForCompat, "json", undefined, { lifecycle: "accepted-legacy" })).data;
    expect(withLc.revision).toMatch(/^[0-9a-f]{64}$/);
  });
});
