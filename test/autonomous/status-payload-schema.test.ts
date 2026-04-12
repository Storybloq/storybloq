/**
 * T-259: StatusPayload schema foundation tests.
 *
 * Tests the contract between the TS MCP server (producer) and Swift apps (consumer).
 * Covers: payload builder mapping, null defaults, JSON fixture round-trip,
 * and Zod schema acceptance with/without new fields.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildActivePayload,
  buildInactivePayload,
} from "../../src/autonomous/status-payload.js";
import type {
  StatusPayloadActive,
  SessionState,
} from "../../src/autonomous/session-types.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "..", "fixtures");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf-8"));
}

function makeFullSessionState(): SessionState {
  return {
    sessionId: "e1536ebc-746a-42ba-b41e-f037cb4c880b",
    state: "CODE_REVIEW",
    ticket: { id: "T-042", title: "Add telemetry substrate", risk: "medium" },
    completedTickets: [{ id: "T-040" }, { id: "T-041" }],
    contextPressure: { level: "low" },
    git: { branch: "telemetry-substrate" },
    lastGuideCall: "2026-04-11T09:58:00Z",
    substage: "CODE_REVIEW:lens:2",
    substageStartedAt: "2026-04-11T09:55:00Z",
    pendingInstruction: "Run multi-lens review round 2",
    pendingInstructionSetAt: "2026-04-11T09:55:01Z",
    claudeCodeSessionId: "5567fb78-277f-4443-b8f4-f121fec357ce",
    binaryFingerprint: { mtime: "2026-04-11T08:00:00Z", sha256: "abc123def456" },
    runningSubprocesses: [
      { pid: 12345, category: "build", startedAt: "2026-04-11T09:50:00Z", stage: "CODE_REVIEW" },
    ],
    lastReviewVerdict: {
      stage: "CODE_REVIEW",
      round: 2,
      verdict: "approve",
      findingCount: 17,
      criticalCount: 0,
      majorCount: 6,
      suggestionCount: 4,
      durationMs: 45000,
      summary: "All non-blocking",
    },
    recentDeferrals: { total: 3, critical: 0, high: 1, medium: 2, low: 0 },
    alive: true,
    lastMcpCall: "2026-04-11T09:58:00Z",
    healthState: "healthy",
  };
}

describe("StatusPayload schema foundation (T-259)", () => {
  describe("buildActivePayload", () => {
    it("maps all new telemetry fields from populated SessionState", () => {
      const session = makeFullSessionState();
      const payload = buildActivePayload(session);

      expect(payload.substage).toBe("CODE_REVIEW:lens:2");
      expect(payload.substageStartedAt).toBe("2026-04-11T09:55:00Z");
      expect(payload.pendingInstruction).toBe("Run multi-lens review round 2");
      expect(payload.pendingInstructionSetAt).toBe("2026-04-11T09:55:01Z");
      expect(payload.claudeCodeSessionId).toBe("5567fb78-277f-4443-b8f4-f121fec357ce");
      expect(payload.binaryFingerprint).toEqual({
        mtime: "2026-04-11T08:00:00Z",
        sha256: "abc123def456",
      });
      expect(payload.runningSubprocesses).toEqual([
        { pid: 12345, category: "build", startedAt: "2026-04-11T09:50:00Z", stage: "CODE_REVIEW" },
      ]);
      expect(payload.lastReviewVerdict).toEqual({
        stage: "CODE_REVIEW",
        round: 2,
        verdict: "approve",
        findingCount: 17,
        criticalCount: 0,
        majorCount: 6,
        suggestionCount: 4,
        durationMs: 45000,
        summary: "All non-blocking",
      });
      expect(payload.recentDeferrals).toEqual({
        total: 3, critical: 0, high: 1, medium: 2, low: 0,
      });
      expect(payload.alive).toBe(true);
      expect(payload.lastMcpCall).toBe("2026-04-11T09:58:00Z");
      expect(payload.healthState).toBe("healthy");
    });

    it("defaults all new fields to null when SessionState has no telemetry fields", () => {
      const minimal: SessionState = {
        sessionId: "abc-123",
        state: "IDLE",
      };
      const payload = buildActivePayload(minimal);

      expect(payload.substage).toBeNull();
      expect(payload.substageStartedAt).toBeNull();
      expect(payload.pendingInstruction).toBeNull();
      expect(payload.pendingInstructionSetAt).toBeNull();
      expect(payload.claudeCodeSessionId).toBeNull();
      expect(payload.binaryFingerprint).toBeNull();
      expect(payload.runningSubprocesses).toBeNull();
      expect(payload.lastReviewVerdict).toBeNull();
      expect(payload.recentDeferrals).toBeNull();
      expect(payload.alive).toBeNull();
      expect(payload.lastMcpCall).toBeNull();
      expect(payload.healthState).toBeNull();
    });

    // T-271: targetWork + currentIssue in status payload
    it("includes targetWork when session has targeted work items", () => {
      const session = makeFullSessionState();
      (session as Record<string, unknown>).targetWork = ["T-042", "T-043", "ISS-010"];
      const payload = buildActivePayload(session);
      expect(payload.targetWork).toEqual(["T-042", "T-043", "ISS-010"]);
    });

    it("sets targetWork to null when session has no targets", () => {
      const session = makeFullSessionState();
      const payload = buildActivePayload(session);
      expect(payload.targetWork).toBeNull();
    });

    it("sets targetWork to null when session has empty target array", () => {
      const session = makeFullSessionState();
      (session as Record<string, unknown>).targetWork = [];
      const payload = buildActivePayload(session);
      expect(payload.targetWork).toBeNull();
    });

    it("includes currentIssue when session is working on an issue", () => {
      const session = makeFullSessionState();
      (session as Record<string, unknown>).currentIssue = {
        id: "ISS-010",
        title: "Flaky test in auth module",
        severity: "high",
      };
      const payload = buildActivePayload(session);
      expect(payload.currentIssue).toEqual({
        id: "ISS-010",
        title: "Flaky test in auth module",
        severity: "high",
      });
    });

    it("sets currentIssue to null when session has no current issue", () => {
      const session = makeFullSessionState();
      const payload = buildActivePayload(session);
      expect(payload.currentIssue).toBeNull();
    });

    it("sets currentIssue to null when session.currentIssue is explicitly null", () => {
      const session = makeFullSessionState();
      (session as Record<string, unknown>).currentIssue = null;
      const payload = buildActivePayload(session);
      expect(payload.currentIssue).toBeNull();
    });
  });

  describe("buildInactivePayload", () => {
    it("returns exact inactive contract shape", () => {
      const payload = buildInactivePayload();
      expect(payload).toEqual({
        schemaVersion: 1,
        sessionActive: false,
        source: "hook",
      });
    });
  });

  describe("contract fixture round-trip", () => {
    it("status-payload-full.json has all 12 new fields with correct types", () => {
      const fixture = loadFixture("status-payload-full.json") as StatusPayloadActive;

      expect(fixture.substage).toBe("CODE_REVIEW:lens:2");
      expect(fixture.substageStartedAt).toBe("2026-04-11T09:55:00Z");
      expect(fixture.pendingInstruction).toBe("Run multi-lens review round 2");
      expect(fixture.pendingInstructionSetAt).toBe("2026-04-11T09:55:01Z");
      expect(fixture.claudeCodeSessionId).toBe("5567fb78-277f-4443-b8f4-f121fec357ce");
      expect(fixture.binaryFingerprint).toEqual({
        mtime: "2026-04-11T08:00:00Z",
        sha256: "abc123def456",
      });
      expect(fixture.runningSubprocesses).toHaveLength(1);
      expect(fixture.lastReviewVerdict?.findingCount).toBe(17);
      expect(fixture.lastReviewVerdict?.criticalCount).toBe(0);
      expect(fixture.lastReviewVerdict?.majorCount).toBe(6);
      expect(fixture.lastReviewVerdict?.suggestionCount).toBe(4);
      expect(fixture.recentDeferrals?.total).toBe(3);
      expect(fixture.alive).toBe(true);
      expect(fixture.lastMcpCall).toBe("2026-04-11T09:58:00Z");
      expect(fixture.healthState).toBe("healthy");
    });
  });

  describe("Zod SessionStateSchema", () => {
    const requiredBase = {
      schemaVersion: 1,
      sessionId: "e1536ebc-746a-42ba-b41e-f037cb4c880b",
      recipe: "coding",
      state: "IMPLEMENT",
      revision: 1,
      startedAt: "2026-04-11T09:00:00Z",
      lease: {
        lastHeartbeat: "2026-04-11T10:00:00Z",
        expiresAt: "2026-04-11T10:05:00Z",
      },
    };

    it("accepts FullSessionState with new telemetry fields (nullish)", () => {
      const stateJson = {
        ...requiredBase,
        substage: "IMPLEMENT:build:1",
        substageStartedAt: "2026-04-11T10:00:00Z",
        pendingInstruction: "Build the project",
        pendingInstructionSetAt: "2026-04-11T10:00:01Z",
        claudeCodeSessionId: "5567fb78-277f-4443-b8f4-f121fec357ce",
        binaryFingerprint: { mtime: "2026-04-11T08:00:00Z", sha256: "abc" },
        runningSubprocesses: [{ pid: 1, category: "test", startedAt: "2026-04-11T10:00:00Z", stage: "IMPLEMENT" }],
        lastReviewVerdict: { stage: "CODE_REVIEW", round: 1, verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, durationMs: 1000, summary: "clean" },
        recentDeferrals: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        alive: true,
        lastMcpCall: "2026-04-11T10:00:00Z",
        healthState: "healthy",
      };
      const result = SessionStateSchema.safeParse(stateJson);
      expect(result.success).toBe(true);
    });

    it("accepts FullSessionState with new fields set to null", () => {
      const stateJson = {
        ...requiredBase,
        substage: null,
        substageStartedAt: null,
        pendingInstruction: null,
        pendingInstructionSetAt: null,
        claudeCodeSessionId: null,
        binaryFingerprint: null,
        runningSubprocesses: null,
        lastReviewVerdict: null,
        recentDeferrals: null,
        alive: null,
        lastMcpCall: null,
        healthState: null,
      };
      const result = SessionStateSchema.safeParse(stateJson);
      expect(result.success).toBe(true);
    });

    it("accepts old-format FullSessionState without new fields", () => {
      const result = SessionStateSchema.safeParse(requiredBase);
      expect(result.success).toBe(true);
    });
  });
});
