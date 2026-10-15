import { describe, it, expect } from "vitest";
import { topologicalSortNodes, buildFederationState } from "../../src/federation/state.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";
import type { NodeScanResult } from "../../src/federation/scanner.js";
import type { Config } from "../../src/models/config.js";

const baseConfig: Config = {
  version: 2,
  schemaVersion: 2,
  project: "studio",
  type: "orchestrator",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  nodes: {
    engine: { path: "/dev/engine", health: "green", role: "Core engine", summary: "", dependsOn: [] },
    cloud: { path: "/dev/cloud", health: "yellow", role: "Cloud API", summary: "", dependsOn: ["engine"] },
    conductor: { path: "/dev/conductor", health: "grey", role: "Orchestration", summary: "", dependsOn: ["engine", "cloud"] },
  },
};

describe("topologicalSortNodes", () => {
  it("orders leaves first, dependents after", () => {
    const nodes = {
      conductor: { dependsOn: ["engine", "cloud"] },
      engine: { dependsOn: [] },
      cloud: { dependsOn: ["engine"] },
    };
    const sorted = topologicalSortNodes(nodes);
    const engineIdx = sorted.indexOf("engine");
    const cloudIdx = sorted.indexOf("cloud");
    const conductorIdx = sorted.indexOf("conductor");
    expect(engineIdx).toBeLessThan(cloudIdx);
    expect(cloudIdx).toBeLessThan(conductorIdx);
  });

  it("returns empty array for empty input", () => {
    expect(topologicalSortNodes({})).toEqual([]);
  });

  it("falls back to alphabetical on cycle", () => {
    const nodes = {
      b: { dependsOn: ["a"] },
      a: { dependsOn: ["b"] },
    };
    const sorted = topologicalSortNodes(nodes);
    expect(sorted).toHaveLength(2);
    expect(sorted).toContain("a");
    expect(sorted).toContain("b");
  });

  it("silently drops dangling dependsOn references", () => {
    const nodes = {
      cloud: { dependsOn: ["engine", "nonexistent"] },
      engine: { dependsOn: [] },
    };
    const sorted = topologicalSortNodes(nodes);
    expect(sorted).toEqual(["engine", "cloud"]);
  });

  it("returns alphabetical for nodes without dependencies", () => {
    const nodes = {
      cloud: {},
      agent: {},
      engine: {},
    };
    const sorted = topologicalSortNodes(nodes);
    expect(sorted).toEqual(["agent", "cloud", "engine"]);
  });
});

describe("buildFederationState", () => {
  it("aggregates counts across reachable nodes", () => {
    const twoNodeConfig: Config = {
      ...baseConfig,
      nodes: {
        engine: { path: "/dev/engine", health: "green", role: "Core engine", summary: "", dependsOn: [] },
        cloud: { path: "/dev/cloud", health: "yellow", role: "Cloud API", summary: "", dependsOn: ["engine"] },
      },
    };

    const resolved = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: "/dev/engine", storyDir: "/dev/engine/.story", rawPath: "/dev/engine" }],
      ["cloud", { resolved: true, absolutePath: "/dev/cloud", storyDir: "/dev/cloud/.story", rawPath: "/dev/cloud" }],
    ]);

    const scans = new Map<string, NodeScanResult>([
      ["engine", {
        reachable: true,
        summary: { project: "engine", type: "npm", ticketCount: 10, openTickets: 3, completeTickets: 7, deliveredTickets: 7, withdrawnTickets: 0, ticketWarnings: 0, excludedTickets: 0, partial: false, countingContract: 2, issueCount: 2, openIssues: 1, lastHandoverDate: "2026-05-01", lastHandoverTitle: "Session" },
      }],
      ["cloud", {
        reachable: true,
        summary: { project: "cloud", type: "npm", ticketCount: 5, openTickets: 2, completeTickets: 3, deliveredTickets: 3, withdrawnTickets: 0, ticketWarnings: 0, excludedTickets: 0, partial: false, countingContract: 2, issueCount: 1, openIssues: 0, lastHandoverDate: null, lastHandoverTitle: null },
      }],
    ]);

    const state = buildFederationState(twoNodeConfig, resolved, scans);
    expect(state.totalTickets).toBe(15);
    expect(state.totalOpenTickets).toBe(5);
    expect(state.totalCompleteTickets).toBe(10);
    expect(state.totalIssues).toBe(3);
    expect(state.totalOpenIssues).toBe(1);
    expect(state.reachableCount).toBe(2);
    expect(state.unreachableCount).toBe(0);
    expect(state.nodeCount).toBe(2);
    expect(state.nodes[0]!.name).toBe("engine");
    expect(state.nodes[1]!.name).toBe("cloud");
  });

  it("includes unreachable nodes with reason", () => {
    const twoNodeConfig: Config = {
      ...baseConfig,
      nodes: {
        engine: { path: "/dev/engine", health: "green", role: "Core engine", summary: "", dependsOn: [] },
        cloud: { path: "/dev/cloud", health: "yellow", role: "Cloud API", summary: "", dependsOn: ["engine"] },
      },
    };

    const resolved = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: "/dev/engine", storyDir: "/dev/engine/.story", rawPath: "/dev/engine" }],
      ["cloud", { resolved: false, reason: "not found", rawPath: "/dev/cloud" }],
    ]);

    const scans = new Map<string, NodeScanResult>([
      ["engine", {
        reachable: true,
        summary: { project: "engine", type: "npm", ticketCount: 10, openTickets: 3, completeTickets: 7, deliveredTickets: 7, withdrawnTickets: 0, ticketWarnings: 0, excludedTickets: 0, partial: false, countingContract: 2, issueCount: 2, openIssues: 1, lastHandoverDate: null, lastHandoverTitle: null },
      }],
      ["cloud", { reachable: false, reason: "not found" }],
    ]);

    const state = buildFederationState(twoNodeConfig, resolved, scans);
    expect(state.reachableCount).toBe(1);
    expect(state.unreachableCount).toBe(1);
    const cloudEntry = state.nodes.find((n) => n.name === "cloud")!;
    expect(cloudEntry.reachable).toBe(false);
    expect(cloudEntry.unreachableReason).toBeTruthy();
  });

  it("returns valid state with all nodes unreachable", () => {
    const resolved = new Map<string, ResolvedNode>([
      ["engine", { resolved: false, reason: "not found", rawPath: "/dev/engine" }],
    ]);
    const scans = new Map<string, NodeScanResult>([
      ["engine", { reachable: false, reason: "not found" }],
    ]);

    const config = { ...baseConfig, nodes: { engine: { path: "/dev/engine", health: "grey" as const, dependsOn: [] } } };
    const state = buildFederationState(config, resolved, scans);
    expect(state.reachableCount).toBe(0);
    expect(state.totalTickets).toBe(0);
    expect(state.totalIssues).toBe(0);
    expect(state.orchestratorProject).toBe("studio");
  });

  it("treats node absent from scan map as unreachable with reason 'unknown'", () => {
    const config = { ...baseConfig, nodes: { engine: { path: "/dev/engine", health: "green" as const, dependsOn: [] } } };
    const resolved = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: "/dev/engine", storyDir: "/dev/engine/.story", rawPath: "/dev/engine" }],
    ]);
    const scans = new Map<string, NodeScanResult>();

    const state = buildFederationState(config, resolved, scans);
    expect(state.reachableCount).toBe(0);
    expect(state.unreachableCount).toBe(1);
    const entry = state.nodes[0]!;
    expect(entry.reachable).toBe(false);
    expect(entry.unreachableReason).toBe("unknown");
  });

  it("carries both rawPath and resolvedPath in entries", () => {
    const resolved = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: "/resolved/engine", storyDir: "/resolved/engine/.story", rawPath: "~/dev/engine" }],
    ]);
    const scans = new Map<string, NodeScanResult>([
      ["engine", {
        reachable: true,
        summary: { project: "engine", type: "npm", ticketCount: 0, openTickets: 0, completeTickets: 0, deliveredTickets: 0, withdrawnTickets: 0, ticketWarnings: 0, excludedTickets: 0, partial: false, countingContract: 2, issueCount: 0, openIssues: 0, lastHandoverDate: null, lastHandoverTitle: null },
      }],
    ]);

    const config = { ...baseConfig, nodes: { engine: { path: "~/dev/engine", health: "green" as const, dependsOn: [] } } };
    const state = buildFederationState(config, resolved, scans);
    const entry = state.nodes[0]!;
    expect(entry.rawPath).toBe("~/dev/engine");
    expect(entry.resolvedPath).toBe("/resolved/engine");
  });
});
