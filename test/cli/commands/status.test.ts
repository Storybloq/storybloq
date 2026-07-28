import { describe, it, expect } from "vitest";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { formatStatus, formatFederatedStatus } from "../../../src/core/output-formatter.js";
import { makeState, makeTicket, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";
import type { ActiveSessionSummary } from "../../../src/core/session-scan.js";
import type { FederationState } from "../../../src/federation/state.js";
import type { Config } from "../../../src/models/config.js";

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
  it("returns formatted status for md", async () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = await handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns valid JSON for json format", async () => {
    const ctx = makeCtx({ format: "json" });
    const result = await handleStatus(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.project).toBe("test");
  });

  it("handles empty project", async () => {
    const ctx = makeCtx();
    const result = await handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.output).toContain("0/0");
  });

  it("defaults to OK exit code", async () => {
    const ctx = makeCtx();
    const result = await handleStatus(ctx);
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
    expect(output).not.toContain("abcdef12");
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
    expect(output).toContain("T-001: First");
    expect(output).toContain("T-002: Second");
    expect(output).not.toContain("sess-aaa");
    expect(output).not.toContain("sess-bbb");
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

  it("keeps Markdown concise and exposes full ownership metadata in JSON", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "full-storybloq-session-id",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-020",
      ticketTitle: "Native task ownership",
      ownerTask: { client: "codex", id: "codex-thread-id", boundAt: "2026-07-09T00:00:00Z" },
      leaseExpiresAt: "2026-07-09T01:00:00Z",
      leaseState: "live",
      compactPending: false,
    }];

    const markdown = formatStatus(state, "md", sessions);
    expect(markdown).toContain("T-020: Native task ownership -- IMPLEMENT in a Codex task");
    expect(markdown).not.toContain("codex-thread-id");
    expect(markdown).not.toContain("full-storybloq-session-id");

    const parsed = JSON.parse(formatStatus(state, "json", sessions));
    expect(parsed.data.activeSessions[0]).toMatchObject({
      sessionId: "full-storybloq-session-id",
      ownerTask: { client: "codex", id: "codex-thread-id" },
      leaseState: "live",
      compactPending: false,
    });
  });

  it("reports expired compact recovery separately from activeSessions", () => {
    const state = makeState();
    const compact: ActiveSessionSummary = {
      sessionId: "compact-session-id",
      state: "COMPACT",
      mode: "auto",
      ticketId: "T-021",
      ticketTitle: "Recover task",
      ownerTask: null,
      leaseExpiresAt: "2026-07-09T00:00:00Z",
      leaseState: "expired",
      compactPending: true,
    };
    const parsed = JSON.parse(formatStatus(state, "json", [], [compact]));
    // ISS-891: empty rather than absent. A COMPACT session is reported ONLY under
    // resumableSessions, and activeSessions says so explicitly instead of leaving
    // the reader to infer it from a missing key.
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toHaveLength(1);
    expect(parsed.data.resumableSessions[0].sessionId).toBe("compact-session-id");

    const markdown = formatStatus(state, "md", [], [compact]);
    expect(markdown).toContain("## Resumable Sessions");
    expect(markdown).toContain("T-021: Recover task -- COMPACT recovery available (expired lease)");
    expect(markdown).not.toContain("compact-session-id");
  });

  it("emits both session arrays empty rather than omitting them (ISS-891)", () => {
    // Contract change. Omission made "no sessions" and "server too old to report
    // sessions" the same observation, so a consumer had to fail closed and
    // re-verify through the CLI. Presence is now the capability signal; the
    // contents are the answer.
    const state = makeState();
    const parsed = JSON.parse(formatStatus(state, "json", []));
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toEqual([]);
    expect(Object.keys(parsed.data)).toContain("activeSessions");
    expect(Object.keys(parsed.data)).toContain("resumableSessions");
  });

  it("emits both session arrays empty on an orchestrator too (ISS-891)", () => {
    // The active-session guard reads status without knowing the project type, so
    // the federated path has to carry the same contract or the guard is back to
    // fail-closed on orchestrators.
    const parsed = JSON.parse(
      formatFederatedStatus(sampleFedState, orchestratorConfig, "json", []),
    );
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toEqual([]);
  });

  it("still reports sessions when they exist, on both paths (ISS-891)", () => {
    // Guards the opposite failure: hardcoding the empty arrays. BOTH arrays carry
    // a distinct session on BOTH paths, because feeding only one of them leaves
    // the other satisfied by a hardcoded [] and proves nothing about it.
    const active: ActiveSessionSummary = {
      sessionId: "sess-active",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-030",
      ticketTitle: "Active",
    };
    const resumable: ActiveSessionSummary = {
      sessionId: "sess-resumable",
      state: "COMPACT",
      mode: "auto",
      ticketId: "T-031",
      ticketTitle: "Resumable",
      leaseState: "expired",
      compactPending: true,
    };

    const plain = JSON.parse(formatStatus(makeState(), "json", [active], [resumable]));
    expect(plain.data.activeSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-active",
    ]);
    expect(plain.data.resumableSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-resumable",
    ]);

    const federated = JSON.parse(
      formatFederatedStatus(sampleFedState, orchestratorConfig, "json", [active], [resumable]),
    );
    expect(federated.data.activeSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-active",
    ]);
    expect(federated.data.resumableSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-resumable",
    ]);
  });
});

const orchestratorConfig: Config = {
  version: 2,
  schemaVersion: 2,
  project: "studio",
  type: "orchestrator",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  nodes: {
    engine: { path: "~/Dev/engine", health: "green", role: "Core engine", summary: "Pipeline working", dependsOn: [] },
    cloud: { path: "~/Dev/cloud", health: "yellow", role: "Cloud API", summary: "Webhook system", dependsOn: ["engine"] },
  },
};

const sampleFedState: FederationState = {
  orchestratorProject: "studio",
  nodeCount: 2,
  reachableCount: 2,
  unreachableCount: 0,
  nodes: [
    {
      name: "engine",
      rawPath: "~/Dev/engine",
      resolvedPath: "/Users/dev/engine",
      health: "green",
      role: "Core engine",
      summary: "Pipeline working",
      dependsOn: [],
      reachable: true,
      scanSummary: {
        project: "engine", type: "npm", ticketCount: 45, openTickets: 10,
        completeTickets: 35, issueCount: 5, openIssues: 3,
        lastHandoverDate: "2026-05-18", lastHandoverTitle: "Session",
      },
    },
    {
      name: "cloud",
      rawPath: "~/Dev/cloud",
      resolvedPath: "/Users/dev/cloud",
      health: "yellow",
      role: "Cloud API",
      summary: "Webhook system",
      dependsOn: ["engine"],
      reachable: true,
      scanSummary: {
        project: "cloud", type: "npm", ticketCount: 30, openTickets: 8,
        completeTickets: 22, issueCount: 3, openIssues: 2,
        lastHandoverDate: "2026-05-17", lastHandoverTitle: "Feature",
      },
    },
  ],
  totalTickets: 75,
  totalOpenTickets: 18,
  totalCompleteTickets: 57,
  totalIssues: 8,
  totalOpenIssues: 5,
  lastScanTimestamp: new Date().toISOString(),
};

describe("formatFederatedStatus (T-334)", () => {
  it("shows orchestrator heading with federation summary", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("studio");
    expect(output).toContain("orchestrator");
    expect(output).toContain("2 nodes");
  });

  it("shows node table with health and counts", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("engine");
    expect(output).toContain("green");
    expect(output).toContain("cloud");
    expect(output).toContain("yellow");
  });

  it("shows aggregated ticket/issue totals", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("75");
    expect(output).toContain("5 open");
  });

  it("shows unreachable nodes with reason", () => {
    const withUnreachable: FederationState = {
      ...sampleFedState,
      reachableCount: 1,
      unreachableCount: 1,
      nodes: [
        sampleFedState.nodes[0]!,
        {
          name: "cloud",
          rawPath: "~/Dev/cloud",
          resolvedPath: null,
          health: "yellow",
          role: "Cloud API",
          summary: "",
          dependsOn: ["engine"],
          reachable: false,
          unreachableReason: "path does not exist",
        },
      ],
    };
    const output = formatFederatedStatus(withUnreachable, orchestratorConfig, "md");
    expect(output).toContain("unreachable");
  });

  it("produces valid JSON output", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "json");
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.data.federation).toBeDefined();
    expect(parsed.data.federation.nodeCount).toBe(2);
    expect(parsed.data.federation.totalTickets).toBe(75);
  });

  it("includes review backends when configured", () => {
    const configWithReview: Config = {
      ...orchestratorConfig,
      recipeOverrides: { reviewBackends: ["lenses", "agent"] },
    };
    const output = formatFederatedStatus(sampleFedState, configWithReview, "md");
    expect(output).toContain("lenses");
  });
});
