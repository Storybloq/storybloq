import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFederationCache, writeFederationCache } from "../../src/federation/cache.js";
import type { FederationState } from "../../src/federation/state.js";
import type { CrossNodeRefStatus } from "../../src/federation/cross-node-resolver.js";

const tmpDirs: string[] = [];

async function createStoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fed-cache-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(storyDir, { recursive: true });
  return storyDir;
}

const sampleState: FederationState = {
  orchestratorProject: "studio",
  nodeCount: 2,
  reachableCount: 1,
  unreachableCount: 1,
  nodes: [
    {
      name: "engine",
      rawPath: "~/dev/engine",
      resolvedPath: "/dev/engine",
      health: "green",
      role: "Core engine",
      summary: "",
      dependsOn: [],
      reachable: true,
      scanSummary: {
        project: "engine", type: "npm", ticketCount: 10, openTickets: 3,
        completeTickets: 7, deliveredTickets: 7, withdrawnTickets: 0, ticketWarnings: 0, excludedTickets: 0, partial: false, countingContract: 2, issueCount: 2, openIssues: 1,
        lastHandoverDate: "2026-05-01", lastHandoverTitle: "Session",
      },
    },
    {
      name: "cloud",
      rawPath: "~/dev/cloud",
      resolvedPath: null,
      health: "yellow",
      role: "Cloud API",
      summary: "",
      dependsOn: ["engine"],
      reachable: false,
      unreachableReason: "not found",
    },
  ],
  totalTickets: 10,
  totalOpenTickets: 3,
  totalCompleteTickets: 7, totalDeliveredTickets: 7, totalWithdrawnTickets: 0, legacyExcludedNodes: 0, partialNodes: 0, totalExcludedTickets: 0,
  totalIssues: 2,
  totalOpenIssues: 1,
  lastScanTimestamp: new Date().toISOString(),
};

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("writeFederationCache + readFederationCache", () => {
  it("write then read roundtrip preserves data", async () => {
    const storyDir = await createStoryDir();
    writeFederationCache(storyDir, sampleState);
    const cache = readFederationCache(storyDir);
    expect(cache).not.toBeNull();
    if (cache) {
      expect(cache.lastScanTimestamp).toBeTruthy();
      expect(cache.nodes.engine.ticketCount).toBe(10);
      expect(cache.nodes.engine.openTickets).toBe(3);
      expect(cache.nodes.engine.reachable).toBe(true);
      expect(cache.nodes.cloud.reachable).toBe(false);
      expect(cache.nodes.cloud.unreachableReason).toBe("not found");
    }
  });
});

describe("readFederationCache", () => {
  it("returns null for missing cache file", async () => {
    const storyDir = await createStoryDir();
    const cache = readFederationCache(storyDir);
    expect(cache).toBeNull();
  });

  it("returns null for corrupt cache file", async () => {
    const storyDir = await createStoryDir();
    await writeFile(join(storyDir, "federation-cache.json"), "{ corrupt }");
    const cache = readFederationCache(storyDir);
    expect(cache).toBeNull();
  });
});

describe("writeFederationCache", () => {
  it("creates valid JSON file", async () => {
    const storyDir = await createStoryDir();
    writeFederationCache(storyDir, sampleState);
    const raw = await readFile(join(storyDir, "federation-cache.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.lastScanTimestamp).toBeTruthy();
    expect(parsed.nodes).toBeDefined();
  });
});

// ISS-1393: the detail ids behind a withdrawn or withheld ref ride beside the
// plain status strings, rebuilt from each observation.
describe("crossNodeRefDetails", () => {
  const observed = new Map<string, CrossNodeRefStatus>([
    ["engine:T-001", { resolved: true, status: "complete" }],
    ["engine:T-002", { resolved: true, status: "withdrawn", detail: ["T-002"] }],
    ["engine:T-003", { resolved: true, status: "withheld", detail: ["T-004"] }],
    ["engine:T-999", { resolved: false, reason: "item not found in node" }],
  ]);

  it("writes the detail of exactly the refs that carry one, statuses unchanged", async () => {
    const storyDir = await createStoryDir();
    writeFederationCache(storyDir, sampleState, observed);
    const parsed = JSON.parse(await readFile(join(storyDir, "federation-cache.json"), "utf-8"));
    expect(parsed.crossNodeRefStatuses).toEqual({
      "engine:T-001": "complete", "engine:T-002": "withdrawn", "engine:T-003": "withheld", "engine:T-999": "unresolved",
    });
    expect(parsed.crossNodeRefDetails).toEqual({ "engine:T-002": ["T-002"], "engine:T-003": ["T-004"] });
  });

  it("is rebuilt on every write: a ref that releases drops its detail, no statuses means no key", async () => {
    const storyDir = await createStoryDir();
    writeFederationCache(storyDir, sampleState, observed);
    const next = new Map(observed);
    next.set("engine:T-003", { resolved: true, status: "complete" });
    writeFederationCache(storyDir, sampleState, next);
    const parsed = JSON.parse(await readFile(join(storyDir, "federation-cache.json"), "utf-8"));
    expect(parsed.crossNodeRefDetails).toEqual({ "engine:T-002": ["T-002"] });
    writeFederationCache(storyDir, sampleState);
    const bare = JSON.parse(await readFile(join(storyDir, "federation-cache.json"), "utf-8"));
    expect("crossNodeRefDetails" in bare).toBe(false);
    expect("crossNodeRefStatuses" in bare).toBe(false);
  });

  it("is left out when no observed ref carries a detail", async () => {
    const storyDir = await createStoryDir();
    writeFederationCache(storyDir, sampleState, new Map([["engine:T-001", { resolved: true, status: "complete" }]]));
    const parsed = JSON.parse(await readFile(join(storyDir, "federation-cache.json"), "utf-8"));
    expect("crossNodeRefDetails" in parsed).toBe(false);
  });

  it("reads back with the statuses the CLI acts on unchanged", async () => {
    const storyDir = await createStoryDir();
    writeFederationCache(storyDir, sampleState, observed);
    const cache = readFederationCache(storyDir);
    expect(cache?.crossNodeRefStatuses?.["engine:T-003"]).toBe("withheld");
    expect(cache?.crossNodeRefDetails?.["engine:T-003"]).toEqual(["T-004"]);
  });
});
