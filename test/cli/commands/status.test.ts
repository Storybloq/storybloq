import { describe, it, expect } from "vitest";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { formatStatus } from "../../../src/core/output-formatter.js";
import { makeState, makeTicket, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";
import type { ActiveSessionSummary } from "../../../src/core/session-scan.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleStatus", () => {
  it("returns formatted status for md", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns valid JSON for json format", () => {
    const ctx = makeCtx({ format: "json" });
    const result = handleStatus(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.project).toBe("test");
  });

  it("handles empty project", () => {
    const ctx = makeCtx();
    const result = handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.output).toContain("0/0");
  });

  it("defaults to OK exit code", () => {
    const ctx = makeCtx();
    const result = handleStatus(ctx);
    expect(result.exitCode).toBeUndefined();
  });
});

describe("formatStatus with active sessions (ISS-023)", () => {
  it("shows no Active Sessions section when no sessions exist", () => {
    const state = makeState();
    const output = formatStatus(state, "md", []);
    expect(output).not.toContain("Active Sessions");
  });

  it("shows Active Sessions section with session details", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "abcdef1234567890",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-042",
      ticketTitle: "Build API endpoint",
    }];
    const output = formatStatus(state, "md", sessions);
    expect(output).toContain("## Active Sessions");
    expect(output).toContain("abcdef12");
    expect(output).toContain("IMPLEMENT");
    expect(output).toContain("T-042");
    expect(output).toContain("auto mode");
  });

  it("excludes sessions from output when array is empty", () => {
    const state = makeState();
    const output = formatStatus(state, "md", []);
    expect(output).not.toContain("## Active Sessions");
  });

  it("shows multiple active sessions", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [
      { sessionId: "sess-aaa", state: "PLAN", mode: "guided", ticketId: "T-001", ticketTitle: "First" },
      { sessionId: "sess-bbb", state: "CODE_REVIEW", mode: "review", ticketId: "T-002", ticketTitle: "Second" },
    ];
    const output = formatStatus(state, "md", sessions);
    expect(output).toContain("sess-aaa");
    expect(output).toContain("sess-bbb");
    expect(output).toContain("guided mode");
    expect(output).toContain("review mode");
  });

  it("includes activeSessions in JSON output", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "sess-json",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-010",
      ticketTitle: "JSON test",
    }];
    const output = formatStatus(state, "json", sessions);
    const parsed = JSON.parse(output);
    expect(parsed.data.activeSessions).toHaveLength(1);
    expect(parsed.data.activeSessions[0].sessionId).toBe("sess-json");
  });

  it("omits activeSessions key from JSON when no sessions", () => {
    const state = makeState();
    const output = formatStatus(state, "json", []);
    const parsed = JSON.parse(output);
    expect(parsed.data.activeSessions).toBeUndefined();
  });
});
