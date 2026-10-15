import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanNodeSummary, scanAllSummaries, loadNodeFullState } from "../../src/federation/scanner.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

async function createNodeProject(opts: {
  name?: string;
  tickets?: Array<{ id: string; status: string }>;
  issues?: Array<{ id: string; status: string; severity: string }>;
  handovers?: string[];
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fed-scanner-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });

  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: opts.name ?? "test-node",
      type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
  );
  await writeFile(
    join(storyDir, "roadmap.json"),
    JSON.stringify({ version: 2, phases: [], blockers: [] }),
  );

  for (const t of opts.tickets ?? []) {
    await writeFile(
      join(storyDir, "tickets", `${t.id}.json`),
      JSON.stringify({
        // T-486 U2-3b: the scanner reads tickets through the loader, so the
        // fixture records are schema-valid ones.
        id: t.id, title: "Test ticket", type: "task",
        status: t.status, phase: null, order: 10, blockedBy: [],
        description: "", parentTicket: null, createdDate: "2026-01-01",
        completedDate: t.status === "complete" ? "2026-01-02" : null,
      }),
    );
  }

  for (const iss of opts.issues ?? []) {
    await writeFile(
      join(storyDir, "issues", `${iss.id}.json`),
      JSON.stringify({
        id: iss.id, title: "Test issue", status: iss.status,
        severity: iss.severity, impact: "test", relatedTickets: [],
        created: "2026-01-01",
      }),
    );
  }

  for (const h of opts.handovers ?? []) {
    await writeFile(join(storyDir, "handovers", h), `# Handover\nContent`);
  }

  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("scanNodeSummary", () => {
  it("returns correct counts for a node with tickets and issues", async () => {
    const dir = await createNodeProject({
      name: "engine",
      tickets: [
        { id: "T-001", status: "complete" },
        { id: "T-002", status: "open" },
        { id: "T-003", status: "inprogress" },
      ],
      issues: [
        { id: "ISS-001", status: "open", severity: "high" },
        { id: "ISS-002", status: "resolved", severity: "low" },
      ],
    });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.project).toBe("engine");
    expect(result.type).toBe("npm");
    expect(result.ticketCount).toBe(3);
    expect(result.completeTickets).toBe(1);
    // Open is every non-terminal counted leaf, so T-003 (in progress) is open.
    expect(result.openTickets).toBe(2);
    expect(result.issueCount).toBe(2);
    expect(result.openIssues).toBe(1);
  });

  it("handles empty tickets/issues directories", async () => {
    const dir = await createNodeProject({ name: "empty" });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.ticketCount).toBe(0);
    expect(result.issueCount).toBe(0);
  });

  it("tolerates corrupt ticket JSON", async () => {
    const dir = await createNodeProject({ name: "corrupt" });
    await writeFile(join(dir, ".story", "tickets", "T-BAD.json"), "{ invalid }");
    await writeFile(
      join(dir, ".story", "tickets", "T-001.json"),
      JSON.stringify({
        id: "T-001", title: "Good", type: "task", status: "open",
        phase: null, order: 10, blockedBy: [], description: "",
        parentTicket: null, createdDate: "2026-01-01", completedDate: null,
      }),
    );
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.ticketCount).toBe(1);
    // T-486 U2-3b: the refused file is counted as excluded and the summary is partial.
    expect(result.excludedTickets).toBe(1);
    expect(result.partial).toBe(true);
  });

  it("counts in-progress tickets as open (T-486 U2-3b: open is every non-terminal leaf)", async () => {
    const dir = await createNodeProject({
      name: "mixed",
      tickets: [
        { id: "T-001", status: "inprogress" },
        { id: "T-002", status: "inprogress" },
      ],
    });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.ticketCount).toBe(2);
    expect(result.openTickets).toBe(2);
    expect(result.completeTickets).toBe(0);
  });

  it("counts a blocked ticket as open", async () => {
    const dir = await createNodeProject({
      name: "blocked",
      tickets: [{ id: "T-001", status: "inprogress" }],
    });
    await writeFile(
      join(dir, ".story", "tickets", "T-002.json"),
      JSON.stringify({
        id: "T-002", title: "Waits", type: "task", status: "open",
        phase: null, order: 20, blockedBy: ["T-001"], description: "",
        parentTicket: null, createdDate: "2026-01-01", completedDate: null,
      }),
    );
    const result = await scanNodeSummary(join(dir, ".story"));
    expect([result.ticketCount, result.openTickets, result.completeTickets]).toEqual([2, 2, 0]);
  });

  it("tolerates corrupt issue JSON", async () => {
    const dir = await createNodeProject({ name: "corrupt-issue" });
    await writeFile(join(dir, ".story", "issues", "ISS-BAD.json"), "not json");
    await writeFile(
      join(dir, ".story", "issues", "ISS-001.json"),
      JSON.stringify({
        id: "ISS-001", title: "Good issue", status: "open",
        severity: "high", impact: "test", relatedTickets: [],
        created: "2026-01-01",
      }),
    );
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.issueCount).toBe(1);
    expect(result.openIssues).toBe(1);
  });

  it("reads latest handover info", async () => {
    const dir = await createNodeProject({
      name: "with-handovers",
      handovers: ["2026-05-01-session.md", "2026-05-10-feature.md"],
    });
    const result = await scanNodeSummary(join(dir, ".story"));
    expect(result.lastHandoverDate).toBe("2026-05-10");
    expect(result.lastHandoverTitle).toBe("Handover");
  });
});

describe("scanAllSummaries", () => {
  it("scans multiple nodes concurrently", async () => {
    const dir1 = await createNodeProject({
      name: "engine",
      tickets: [{ id: "T-001", status: "complete" }],
    });
    const dir2 = await createNodeProject({
      name: "cloud",
      tickets: [{ id: "T-001", status: "open" }, { id: "T-002", status: "open" }],
    });

    const nodes = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: dir1, storyDir: join(dir1, ".story"), rawPath: dir1 }],
      ["cloud", { resolved: true, absolutePath: dir2, storyDir: join(dir2, ".story"), rawPath: dir2 }],
    ]);

    const results = await scanAllSummaries(nodes);
    expect(results.size).toBe(2);

    const engineResult = results.get("engine")!;
    expect(engineResult.reachable).toBe(true);
    if (engineResult.reachable) {
      expect(engineResult.summary.ticketCount).toBe(1);
    }

    const cloudResult = results.get("cloud")!;
    expect(cloudResult.reachable).toBe(true);
    if (cloudResult.reachable) {
      expect(cloudResult.summary.ticketCount).toBe(2);
    }
  });

  it("skips unresolved nodes", async () => {
    const dir = await createNodeProject({ name: "engine" });
    const nodes = new Map<string, ResolvedNode>([
      ["engine", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
      ["missing", { resolved: false, reason: "not found", rawPath: "/missing" }],
    ]);

    const results = await scanAllSummaries(nodes);
    expect(results.size).toBe(2);

    const missingResult = results.get("missing")!;
    expect(missingResult.reachable).toBe(false);
    if (!missingResult.reachable) {
      expect(missingResult.reason).toBeTruthy();
    }
  });

  it("handles all nodes being unreachable", async () => {
    const nodes = new Map<string, ResolvedNode>([
      ["a", { resolved: false, reason: "not found", rawPath: "/a" }],
      ["b", { resolved: false, reason: "not found", rawPath: "/b" }],
    ]);

    const results = await scanAllSummaries(nodes);
    expect(results.size).toBe(2);
    for (const [, result] of results) {
      expect(result.reachable).toBe(false);
    }
  });

  it("does not throw on timeout (contract: timeout produces unreachable or scan completes)", async () => {
    const tickets = Array.from({ length: 50 }, (_, i) => ({
      id: `T-${String(i + 1).padStart(3, "0")}`,
      status: "open",
    }));
    const dir = await createNodeProject({ name: "slow", tickets });
    const nodes = new Map([
      ["slow", { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
    ]);
    const results = await scanAllSummaries(nodes, { timeoutMs: 1 });
    const result = results.get("slow")!;
    expect(result).toBeDefined();
    if (result.reachable) {
      expect(result.summary.ticketCount).toBe(50);
    } else {
      expect(result.reason).toMatch(/timeout|scan error/);
    }
  });
});

describe("loadNodeFullState", () => {
  it("loads project from story dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-fullstate-"));
    tmpDirs.push(dir);
    const storyDir = join(dir, ".story");
    await mkdir(join(storyDir, "tickets"), { recursive: true });
    await mkdir(join(storyDir, "issues"), { recursive: true });
    await mkdir(join(storyDir, "handovers"), { recursive: true });
    await mkdir(join(storyDir, "notes"), { recursive: true });
    await mkdir(join(storyDir, "lessons"), { recursive: true });
    await writeFile(join(storyDir, "config.json"), JSON.stringify({
      version: 2, schemaVersion: 2, project: "loadtest", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ title: "Roadmap", date: "2026-01-01", phases: [], blockers: [] }));
    await writeFile(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", description: "", type: "task",
      status: "open", phase: null, order: 10, blockedBy: [],
      createdDate: "2026-01-01", completedDate: null,
    }));
    const result = await loadNodeFullState(storyDir);
    expect(result.state.config.project).toBe("loadtest");
    expect(result.state.tickets.length).toBe(1);
  });
});
