import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeRecommendations } from "../../src/federation/node-recommend.js";
import type { FederationNodeEntry, FederationState } from "../../src/federation/state.js";

const tmpDirs: string[] = [];

async function createNodeProject(opts: {
  name: string;
  tickets?: Array<{
    id: string;
    status: "open" | "inprogress" | "complete";
    crossNodeBlockedBy?: string[];
  }>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-node-recommend-${opts.name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  await writeFile(join(storyDir, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 2,
    project: opts.name,
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "Roadmap",
    date: "2026-01-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }],
    blockers: [],
  }));

  for (const ticket of opts.tickets ?? []) {
    await writeFile(join(storyDir, "tickets", `${ticket.id}.json`), JSON.stringify({
      id: ticket.id,
      title: `${opts.name} ticket`,
      description: "",
      type: "task",
      status: ticket.status,
      phase: "p1",
      order: 10,
      blockedBy: [],
      crossNodeBlockedBy: ticket.crossNodeBlockedBy,
      createdDate: "2026-01-01",
      completedDate: ticket.status === "complete" ? "2026-05-01" : null,
    }));
  }

  return dir;
}

async function createCorruptNodeProject(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-node-recommend-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(storyDir, { recursive: true });
  await writeFile(join(storyDir, "config.json"), "{ invalid json }");
  return dir;
}

function makeNode(overrides: Partial<FederationNodeEntry> & { name: string; resolvedPath: string | null }): FederationNodeEntry {
  return {
    name: overrides.name,
    rawPath: overrides.resolvedPath ?? "",
    resolvedPath: overrides.resolvedPath,
    health: "green",
    role: "",
    summary: "",
    dependsOn: [],
    reachable: true,
    ...overrides,
  };
}

function makeState(nodes: FederationNodeEntry[]): FederationState {
  return {
    orchestratorProject: "studio",
    nodeCount: nodes.length,
    reachableCount: nodes.filter((node) => node.reachable).length,
    unreachableCount: nodes.filter((node) => !node.reachable).length,
    nodes,
    totalTickets: 0,
    totalOpenTickets: 0,
    totalCompleteTickets: 0, totalDeliveredTickets: 0, totalWithdrawnTickets: 0, legacyExcludedNodes: 0, partialNodes: 0, totalExcludedTickets: 0,
    totalIssues: 0,
    totalOpenIssues: 0,
    lastScanTimestamp: new Date().toISOString(),
  };
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("loadNodeRecommendations", () => {
  it("reports corrupt reachable nodes as warnings", async () => {
    const root = await createCorruptNodeProject("broken");
    const result = await loadNodeRecommendations(
      makeState([makeNode({ name: "broken", resolvedPath: root })]),
      5,
    );

    expect(result.recommendationsByNode.has("broken")).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ node: "broken", root });
    expect(result.warnings[0]?.reason).toBeTruthy();
  });

  it("passes cross-node statuses into per-node recommendations", async () => {
    const root = await createNodeProject({
      name: "agent",
      tickets: [
        { id: "T-001", status: "inprogress", crossNodeBlockedBy: ["engine:T-010"] },
      ],
    });

    const blocked = await loadNodeRecommendations(
      makeState([makeNode({ name: "agent", resolvedPath: root })]),
      5,
      { "engine:T-010": "open" },
    );
    expect(blocked.recommendationsByNode.get("agent")?.recommendations.find((rec) => rec.id === "T-001")).toBeUndefined();

    const unblocked = await loadNodeRecommendations(
      makeState([makeNode({ name: "agent", resolvedPath: root })]),
      5,
      { "engine:T-010": "complete" },
    );
    expect(unblocked.recommendationsByNode.get("agent")?.recommendations.find((rec) => rec.id === "T-001")).toBeDefined();
  });
});
