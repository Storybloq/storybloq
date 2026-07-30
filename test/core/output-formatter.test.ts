import { describe, it, expect } from "vitest";
import {
  successEnvelope,
  errorEnvelope,
  partialEnvelope,
  escapeMarkdownInline,
  escapeMarkdownDocument,
  fencedBlock,
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
});
