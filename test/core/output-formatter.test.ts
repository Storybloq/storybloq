import { describe, it, expect } from "vitest";
import {
  successEnvelope,
  errorEnvelope,
  partialEnvelope,
  escapeMarkdownInline,
  escapeMarkdownDocument,
  fencedBlock,
  formatStatus,
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
import { makeTicket, makeIssue, makeState, makeRoadmap, makePhase } from "./test-factories.js";
import type { NextTicketOutcome, NextTicketsOutcome } from "../../src/core/queries.js";
import type { RecommendResult } from "../../src/core/recommend.js";
import type { ValidationResult, ValidationFinding } from "../../src/core/validation.js";

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
    };
    const md = formatRecommendations(result, populatedState, "md");
    expect(md).toContain("# Recommendations");
    expect(md).toContain("1. **ISS-001** (issue)");
    expect(md).toContain("2. **T-001** (ticket)");
    expect(md).toContain("_Critical issue_");
    expect(md).toContain("_In-progress_");
  });

  it("empty + populated → 'complete or blocked' message", () => {
    const result: RecommendResult = { recommendations: [], totalCandidates: 0 };
    const md = formatRecommendations(result, populatedState, "md");
    expect(md).toContain("No recommendations");
    expect(md).toContain("complete or blocked");
  });

  it("empty + empty scaffold → setup message", () => {
    const result: RecommendResult = { recommendations: [], totalCandidates: 0 };
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
    };
    const json = formatRecommendations(result, populatedState, "json");
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.data.recommendations).toHaveLength(1);
    expect(parsed.data.totalCandidates).toBe(5);
    expect(parsed.data.isEmptyScaffold).toBe(false);
  });

  it("JSON envelope includes isEmptyScaffold: true for scaffold", () => {
    const result: RecommendResult = { recommendations: [], totalCandidates: 0 };
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
    };
    const md = formatRecommendations(result, populatedState, "md");
    expect(md).toContain("Showing 1 of 8 candidates.");
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
