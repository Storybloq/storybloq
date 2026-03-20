import { describe, it, expect } from "vitest";
import { handleExport } from "../../../src/cli/commands/export.js";
import { formatExport } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import {
  makeTicket,
  makeIssue,
  makePhase,
  makeRoadmap,
  makeState,
  emptyRoadmap,
} from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";

function makeCtx(
  overrides: Partial<Parameters<typeof makeState>[0]> = {},
  format: "md" | "json" = "md",
): CommandContext {
  const state = makeState(overrides);
  return {
    state,
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format,
  };
}

describe("export command", () => {
  describe("handleExport", () => {
    it("throws when --phase value is missing", () => {
      const ctx = makeCtx();
      expect(() => handleExport(ctx, "phase", null)).toThrow(CliValidationError);
    });

    it("throws when phase not found", () => {
      const ctx = makeCtx({
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      expect(() => handleExport(ctx, "phase", "nonexistent")).toThrow("not found");
    });

    it("returns output for valid phase", () => {
      const ctx = makeCtx({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const result = handleExport(ctx, "phase", "p1");
      expect(result.output).toContain("p1");
      expect(result.output).toContain("T-001");
    });

    it("returns output for --all", () => {
      const ctx = makeCtx({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const result = handleExport(ctx, "all", null);
      expect(result.output).toContain("Full Export");
    });
  });
});

describe("formatExport", () => {
  describe("phase export", () => {
    it("MD includes phase name and tickets", () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "complete", title: "Done" }),
          makeTicket({ id: "T-002", phase: "p1", status: "open", title: "Todo" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1", name: "Core" })]),
      });
      const md = formatExport(state, "phase", "p1", "md");
      expect(md).toContain("Core (p1)");
      expect(md).toContain("[x] T-001: Done");
      expect(md).toContain("[ ] T-002: Todo");
    });

    it("MD includes umbrella ancestors as context", () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", title: "Umbrella" }),
          makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001", title: "Child" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const md = formatExport(state, "phase", "p1", "md");
      expect(md).toContain("T-002: Child");
      expect(md).toContain("under T-001");
    });

    it("MD includes cross-phase dependencies", () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-002"] }),
          makeTicket({ id: "T-002", phase: "p2", title: "Blocker in p2" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
      });
      const md = formatExport(state, "phase", "p1", "md");
      expect(md).toContain("Cross-Phase Dependencies");
      expect(md).toContain("T-002");
      expect(md).toContain("Blocker in p2");
    });

    it("MD includes related issues", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        issues: [makeIssue({ id: "ISS-001", phase: "p1", title: "Bug in p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const md = formatExport(state, "phase", "p1", "md");
      expect(md).toContain("Open Issues");
      expect(md).toContain("ISS-001");
    });

    it("JSON is valid and includes phase data", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1", name: "Core" })]),
      });
      const json = formatExport(state, "phase", "p1", "json");
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(1);
      expect(parsed.data.phase.id).toBe("p1");
      expect(parsed.data.tickets).toHaveLength(1);
    });
  });

  describe("full export", () => {
    it("MD includes all phases and tickets", () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
          makeTicket({ id: "T-002", phase: "p2", status: "open" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
      });
      const md = formatExport(state, "all", null, "md");
      expect(md).toContain("Full Export");
      expect(md).toContain("T-001");
      expect(md).toContain("T-002");
      expect(md).toContain("p1");
      expect(md).toContain("p2");
    });

    it("MD includes issues grouped by severity", () => {
      const state = makeState({
        issues: [
          makeIssue({ id: "ISS-001", severity: "critical" }),
          makeIssue({ id: "ISS-002", severity: "low" }),
        ],
      });
      const md = formatExport(state, "all", null, "md");
      expect(md).toContain("## Issues");
      expect(md).toContain("[critical]");
      expect(md).toContain("[low]");
    });

    it("MD includes blockers", () => {
      const state = makeState({
        roadmap: {
          ...emptyRoadmap,
          blockers: [
            { name: "API key", cleared: false, createdDate: "2026-03-10" },
            { name: "Design", cleared: true, createdDate: "2026-03-10", clearedDate: "2026-03-15" },
          ],
        },
      });
      const md = formatExport(state, "all", null, "md");
      expect(md).toContain("## Blockers");
      expect(md).toContain("API key");
      expect(md).toContain("Design");
    });

    it("MD shows ticket counts", () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
          makeTicket({ id: "T-002", phase: "p1", status: "open" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const md = formatExport(state, "all", null, "md");
      expect(md).toContain("1/2 complete");
    });

    it("JSON is valid with full structure", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        issues: [makeIssue({ id: "ISS-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const json = formatExport(state, "all", null, "json");
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(1);
      expect(parsed.data.phases).toHaveLength(1);
      expect(parsed.data.issues).toHaveLength(1);
    });

    it("handles empty project", () => {
      const state = makeState();
      const md = formatExport(state, "all", null, "md");
      expect(md).toContain("Full Export");
      expect(md).toContain("0/0 complete");
    });
  });

  describe("markdown escaping", () => {
    it("escapes special chars in titles", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1", title: "# Heading <script>" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const md = formatExport(state, "phase", "p1", "md");
      // Should not produce raw heading or HTML
      expect(md).not.toMatch(/^# Heading/m);
      expect(md).not.toContain("<script>");
    });
  });
});
