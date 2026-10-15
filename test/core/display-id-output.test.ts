import { describe, it, expect } from "vitest";
import {
  formatTicketList,
  formatIssueList,
  formatRecommendations,
  formatNextTicketOutcome,
  formatNextTicketsOutcome,
  formatRecap,
} from "../../src/core/output-formatter.js";
import { makeTicket, makeIssue, makeState, makeRoadmap, makePhase } from "./test-factories.js";
import type { NextTicketOutcome, NextTicketsOutcome, NextTicketCandidate } from "../../src/core/queries.js";
import type { RecommendResult } from "../../src/core/recommend.js";
import type { RecapResult } from "../../src/core/snapshot.js";

describe("display ID output in aggregate formatters", () => {
  const canonicalTicket = makeTicket({
    id: "t-abcdef1234567890",
    title: "Team ticket",
    displayId: "T-042",
  });
  const canonicalIssue = makeIssue({
    id: "i-abcdef1234567890",
    title: "Team issue",
    displayId: "ISS-042",
  });
  const legacyTicket = makeTicket({ id: "T-001", title: "Legacy ticket" });

  const state = makeState({
    tickets: [canonicalTicket, legacyTicket],
    issues: [canonicalIssue],
    roadmap: makeRoadmap([makePhase({ id: "p1" })]),
  });

  describe("formatTicketList", () => {
    it("shows displayId for team-mode tickets in markdown", () => {
      const md = formatTicketList([canonicalTicket, legacyTicket], "md");
      expect(md).toContain("T-042");
      expect(md).not.toContain("t-abcdef1234567890");
    });

    it("legacy tickets still show raw id", () => {
      const md = formatTicketList([legacyTicket], "md");
      expect(md).toContain("T-001");
    });
  });

  describe("formatIssueList", () => {
    it("shows displayId for team-mode issues in markdown", () => {
      const md = formatIssueList([canonicalIssue], "md");
      expect(md).toContain("ISS-042");
      expect(md).not.toContain("i-abcdef1234567890");
    });
  });

  describe("formatRecommendations", () => {
    it("shows displayId in recommendation list", () => {
      const result: RecommendResult = {
        recommendations: [
          { id: "t-abcdef1234567890", kind: "ticket", title: "Team ticket", category: "open_ticket", reason: "Ready", score: 100, displayId: "T-042" },
        ],
        totalCandidates: 1,
        excludedCount: 0,
        excluded: [],
        unreadableHandoverCount: 0,
      };
      const md = formatRecommendations(result, state, "md");
      expect(md).toContain("T-042");
      expect(md).not.toContain("t-abcdef1234567890");
    });
  });

  describe("formatNextTicketOutcome", () => {
    it("shows displayId for selected ticket", () => {
      const outcome: NextTicketOutcome = {
        kind: "found",
        ticket: canonicalTicket,
        unblockImpact: { ticketId: canonicalTicket.id, wouldUnblock: [] },
        umbrellaProgress: null,
      };
      const md = formatNextTicketOutcome(outcome, state, "md");
      expect(md).toContain("T-042");
      expect(md).not.toContain("t-abcdef1234567890");
    });
  });

  describe("formatNextTicketsOutcome", () => {
    it("shows displayId for candidates", () => {
      const candidate: NextTicketCandidate = {
        ticket: canonicalTicket,
        unblockImpact: { ticketId: canonicalTicket.id, wouldUnblock: [] },
        umbrellaProgress: null,
      };
      const outcome: NextTicketsOutcome = {
        kind: "found",
        candidates: [candidate],
        skippedBlockedPhases: [],
      };
      const md = formatNextTicketsOutcome(outcome, state, "md");
      expect(md).toContain("T-042");
      expect(md).not.toContain("t-abcdef1234567890");
    });
  });

  describe("formatRecap with display IDs", () => {
    it("shows displayId for added tickets in recap", () => {
      const recap: RecapResult = {
        snapshot: { filename: "snap.json", createdAt: "2026-05-26T00:00:00.000Z" },
        changes: {
          tickets: {
            added: [{ id: "t-abcdef1234567890", title: "Team ticket", displayId: "T-042" }],
            removed: [],
            statusChanged: [],
            descriptionChanged: [],
            withdrawn: [],
            withdrawalCleared: [],
          },
          issues: { added: [], resolved: [], statusChanged: [], impactChanged: [] },
          blockers: { added: [], cleared: [] },
          phases: { added: [], removed: [], statusChanged: [] },
          notes: { added: [], removed: [], updated: [] },
          lessons: { added: [], removed: [], updated: [], reinforced: [] },
          handovers: { added: [], removed: [] },
        },
        suggestedActions: {
          nextTicket: null,
          highSeverityIssues: [],
          recentlyClearedBlockers: [],
        },
        partial: false,
      };
      const md = formatRecap(recap, state, "md");
      expect(md).toContain("T-042");
      expect(md).not.toContain("t-abcdef1234567890");
    });
  });
});
