import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, cp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpReadTool, runMcpWriteTool, registerAllTools } from "../../src/mcp/tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Handler imports
import { handleStatus } from "../../src/cli/commands/status.js";
import { handleTicketGet } from "../../src/cli/commands/ticket.js";
import { handlePhaseList, handlePhaseCreate } from "../../src/cli/commands/phase.js";
import { handleIssueList, handleIssueGet } from "../../src/cli/commands/issue.js";
import { handleHandoverList, handleHandoverLatest } from "../../src/cli/commands/handover.js";
import { handleValidate } from "../../src/cli/commands/validate.js";
import { handleBlockerList } from "../../src/cli/commands/blocker.js";
import { handleNodeList } from "../../src/cli/commands/node.js";
import { initProject } from "../../src/core/init.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "valid", "basic");

describe("MCP integration -- real filesystem", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mcp-int-"));
    tmpDirs.push(dir);
    // Copy fixture .story/ to temp dir
    await cp(FIXTURES_DIR, join(dir, ".story"), { recursive: true });
    return dir;
  }

  it("storybloq_status -- full pipeline", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, handleStatus);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Phase");
  });

  it("storybloq_status supports parseable JSON through the MCP read pipeline", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, handleStatus, undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version).toBe(1);
    expect(parsed.data.project).toBeDefined();
  });

  it("storybloq_status -- expiredLeaseSessions is populated through the real MCP boundary for a determinately-expired, non-COMPACT session (ISS-943)", async () => {
    const root = await setupProject();
    const sessDir = join(root, ".story", "sessions", "stale-worker");
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, "state.json"),
      JSON.stringify({
        sessionId: "22222222-2222-4222-8222-222222222222",
        status: "active",
        state: "IMPLEMENT",
        mode: "auto",
        lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      }),
    );
    const result = await runMcpReadTool(root, handleStatus, undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // Through the ACTUAL registered tool's pipeline, not a scanner-function
    // unit test -- this is the consequence acceptance 5 pins: a monitor
    // reading the real storybloq_status output can tell "no session" from
    // "lease lapsed, record present".
    expect(parsed.data.expiredLeaseSessions).toHaveLength(1);
    expect(parsed.data.expiredLeaseSessions[0].sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toEqual([]);
  });

  it("storybloq_status -- expiredLeaseSessions stays empty through the real MCP boundary for an ordinary live-lease session (ISS-943)", async () => {
    const root = await setupProject();
    const sessDir = join(root, ".story", "sessions", "live-worker");
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, "state.json"),
      JSON.stringify({
        sessionId: "33333333-3333-4333-8333-333333333333",
        status: "active",
        state: "IMPLEMENT",
        mode: "auto",
        lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }),
    );
    const result = await runMcpReadTool(root, handleStatus, undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.expiredLeaseSessions).toEqual([]);
    expect(parsed.data.activeSessions).toHaveLength(1);
  });

  it("storybloq_ticket_get -- valid ticket", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-001", ctx));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBeDefined();
  });

  it("storybloq_ticket_get -- not found (informational, not isError)", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-999", ctx));
    // not_found is informational -- NOT isError
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("not found");
  });

  // --- ISS-1154: format/withActionability on issue_get/ticket_get ---

  it("storybloq_issue_get -- format:'json' returns disposition/duplicateOf when set", async () => {
    const root = await setupProject();
    await writeFile(
      join(root, ".story", "issues", "ISS-090.json"),
      JSON.stringify({
        id: "ISS-090",
        title: "Duplicate of an earlier report",
        status: "open",
        severity: "medium",
        components: [],
        impact: "n/a",
        resolution: null,
        location: [],
        discoveredDate: "2026-09-01",
        resolvedDate: null,
        relatedTickets: [],
        disposition: "duplicate",
        duplicateOf: "ISS-001",
      }),
    );
    const result = await runMcpReadTool(root, (ctx) => handleIssueGet("ISS-090", ctx), undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.disposition).toBe("duplicate");
    expect(parsed.data.duplicateOf).toBe("ISS-001");
  });

  it("storybloq_ticket_get -- withActionability:true returns a real tier-3-inclusive verdict for a handover-only exclusion", async () => {
    const root = await setupProject();
    const handoversDir = join(root, ".story", "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-09-12-h1.md"), "## Blocked\n- T-003: waiting on external dependency\n");
    // T-003 is open and unblocked by ledger rules alone -- the ONLY reason to
    // exclude it is the handover-tier mention, proving the targeted lookup
    // genuinely runs tier 3 and not just the ledger/structured/heuristic tiers.
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-003", ctx, true), undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.actionability.status).toBe("blocked");
    expect(parsed.data.actionability.source).toBe("handover");
    expect(parsed.data.unreadableHandoverCount).toBe(0);
  });

  /** T-095, blocked across nodes by engine:T-005. */
  async function writeCrossNodeDependent(root: string): Promise<void> {
    await writeFile(
      join(root, ".story", "tickets", "T-095.json"),
      JSON.stringify({
        id: "T-095",
        title: "Cross-node dependent ticket",
        description: "n/a",
        type: "task",
        status: "open",
        phase: null,
        order: 900,
        createdDate: "2026-09-01",
        completedDate: null,
        blockedBy: [],
        crossNodeBlockedBy: ["engine:T-005"],
      }),
    );
  }

  it("storybloq_ticket_get -- withActionability judges a cross-node blocker by the same live observation recommend() uses", async () => {
    // T-486 U2-4 (ruling 1): a real node ledger whose T-005 is complete.
    const root = await setupProject();
    await writeCrossNodeDependent(root);
    const node = await mkdtemp(join(tmpdir(), "mcp-int-node-"));
    tmpDirs.push(node);
    await initProject(node, { name: "engine" });
    await writeFile(join(node, ".story", "tickets", "T-005.json"), JSON.stringify({
      id: "T-005", title: "Engine work", description: "", type: "task", status: "complete", phase: null,
      order: 10, createdDate: "2026-09-01", completedDate: "2026-09-02", blockedBy: [], parentTicket: null,
    }));
    const configPath = join(root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, nodes: { engine: { path: node } } }));
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-095", ctx, true), undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data.actionability.status).toBe("actionable");
  });

  it("storybloq_ticket_get -- withActionability: a cache that says complete releases nothing when the node is not configured", async () => {
    // T-486 U2-4 (ruling 1): the cache is no longer read for actionability;
    // with no node to observe, the ref is unresolved and the ticket blocked.
    const root = await setupProject();
    await writeCrossNodeDependent(root);
    await writeFile(
      join(root, ".story", "federation-cache.json"),
      JSON.stringify({
        lastScanTimestamp: new Date().toISOString(),
        nodes: {},
        crossNodeRefStatuses: { "engine:T-005": "complete" },
      }),
    );
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-095", ctx, true), undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.actionability.status).toBe("blocked");
  });

  it("storybloq_ticket_get -- withActionability:true on an archived ticket returns complete/ledger, matching how recommend() treats it", async () => {
    const root = await setupProject();
    await writeFile(
      join(root, ".story", "tickets", "T-096.json"),
      JSON.stringify({
        id: "T-096",
        title: "Archived ticket",
        description: "n/a",
        type: "task",
        status: "open",
        phase: null,
        order: 901,
        createdDate: "2026-09-01",
        completedDate: null,
        blockedBy: [],
        lifecycle: "archived",
      }),
    );
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-096", ctx, true), undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.actionability.status).toBe("complete");
    expect(parsed.data.actionability.source).toBe("ledger");
  });

  it("storybloq_ticket_get -- withActionability:false (default) omits the actionability field", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, (ctx) => handleTicketGet("T-003", ctx), undefined, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.actionability).toBeUndefined();
  });

  /**
   * ISS-1154: same real-registration pattern as callHandoverLatest below --
   * exercises the storybloq_ticket_get/storybloq_issue_get/storybloq_recommend
   * zod inputSchema's format/withActionability fields and their forwarding at
   * the tools.ts registration site, which a direct handleTicketGet/
   * handleIssueGet/runMcpReadTool call (as used above) bypasses entirely.
   */
  async function callTool(
    root: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: `${name}-test`, version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    const content = result.content as { text: string }[];
    return { isError: result.isError as boolean | undefined, text: content[0]!.text };
  }

  it("storybloq_ticket_get -- format:'json'+withActionability:true through the real MCP registration returns the actionability field", async () => {
    const root = await setupProject();
    const result = await callTool(root, "storybloq_ticket_get", { id: "T-003", format: "json", withActionability: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.data.actionability).toBeDefined();
    expect(parsed.data.actionability.status).toBeDefined();
  });

  it("storybloq_ticket_get -- withActionability:true with format omitted defaults to JSON through the real MCP registration (the flag would otherwise be silently inert under the markdown default)", async () => {
    const root = await setupProject();
    const result = await callTool(root, "storybloq_ticket_get", { id: "T-003", withActionability: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.data.actionability).toBeDefined();
  });

  it("storybloq_issue_get -- format:'json' through the real MCP registration returns disposition/duplicateOf", async () => {
    const root = await setupProject();
    await writeFile(
      join(root, ".story", "issues", "ISS-091.json"),
      JSON.stringify({
        id: "ISS-091",
        title: "Duplicate via real registration",
        status: "open",
        severity: "medium",
        components: [],
        impact: "n/a",
        resolution: null,
        location: [],
        discoveredDate: "2026-09-01",
        resolvedDate: null,
        relatedTickets: [],
        disposition: "duplicate",
        duplicateOf: "ISS-001",
      }),
    );
    const result = await callTool(root, "storybloq_issue_get", { id: "ISS-091", format: "json" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.data.disposition).toBe("duplicate");
    expect(parsed.data.duplicateOf).toBe("ISS-001");
  });

  it("storybloq_issue_get -- withActionability:true through the real MCP registration returns the actionability field", async () => {
    const root = await setupProject();
    await writeFile(
      join(root, ".story", "issues", "ISS-092.json"),
      JSON.stringify({
        id: "ISS-092",
        title: "Duplicate, actionability via real registration",
        status: "open",
        severity: "medium",
        components: [],
        impact: "n/a",
        resolution: null,
        location: [],
        discoveredDate: "2026-09-01",
        resolvedDate: null,
        relatedTickets: [],
        disposition: "duplicate",
        duplicateOf: "ISS-001",
      }),
    );
    const result = await callTool(root, "storybloq_issue_get", { id: "ISS-092", withActionability: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.data.actionability.status).toBe("duplicate");
    expect(parsed.data.actionability.source).toBe("structured");
  });

  it("storybloq_recommend -- format omitted through the real MCP registration still returns the JSON envelope (excludedCount/excluded/unreadableHandoverCount reachable)", async () => {
    const root = await setupProject();
    const result = await callTool(root, "storybloq_recommend", {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.data.excludedCount).toBeDefined();
    expect(parsed.data.excluded).toBeDefined();
    expect("unreadableHandoverCount" in parsed.data).toBe(true);
  });

  it("storybloq_phase_list -- lists phases", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, handlePhaseList);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("storybloq_issue_list -- lists issues", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, (ctx) =>
      handleIssueList({}, ctx),
    );
    expect(result.isError).toBeUndefined();
  });

  it("storybloq_validate -- validates project", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, handleValidate);
    expect(result.isError).toBeUndefined();
  });

  it("storybloq_blocker_list -- lists blockers", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, handleBlockerList);
    expect(result.isError).toBeUndefined();
  });

  it("storybloq_handover_list -- lists handovers", async () => {
    const root = await setupProject();
    const result = await runMcpReadTool(root, handleHandoverList);
    expect(result.isError).toBeUndefined();
  });

  it("runMcpReadTool(handleNodeList) - benign empty list on a non-orchestrator project (ISS-811)", async () => {
    const root = await setupProject(); // fixture type is "npm" (non-orchestrator)
    const result = await runMcpReadTool(root, handleNodeList);
    // Non-orchestrator LIST is informational, NOT isError, and carries no old error text.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("single-repo mode");
    expect(result.content[0].text).not.toContain("only available on orchestrator");
  });

  it("no project root → ProjectLoaderError (isError: true)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-noproject-"));
    tmpDirs.push(dir);
    const result = await runMcpReadTool(dir, handleStatus);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^\[.+\]/); // plain text with [code] prefix
  });

  it("keeps status infrastructure errors parseable in JSON format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-noproject-json-"));
    tmpDirs.push(dir);
    const result = await runMcpReadTool(dir, handleStatus, undefined, "json");
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      version: 1,
      error: { code: expect.any(String), message: expect.any(String) },
    });
  });

  it("corrupt ticket JSON → permissive load, warning prefix", async () => {
    const root = await setupProject();
    // Write a corrupt ticket file
    await writeFile(
      join(root, ".story", "tickets", "T-BAD.json"),
      "{ not valid json }}",
    );
    const result = await runMcpReadTool(root, handleStatus);
    // Permissive load: succeeds with warning prefix
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Warning:");
    expect(result.content[0].text).toContain("data integrity issues");
  });

  it("keeps integrity warnings structured in MCP status JSON", async () => {
    const root = await setupProject();
    await writeFile(join(root, ".story", "tickets", "T-BAD.json"), "{ not valid json }}");
    const result = await runMcpReadTool(root, handleStatus, undefined, "json");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.partial).toBe(true);
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: expect.stringContaining("T-BAD.json") }),
    ]));
    expect(parsed.data.project).toBeDefined();
  });

  it("corrupt config.json → ProjectLoaderError (isError: true)", async () => {
    const root = await setupProject();
    // Overwrite config with invalid JSON
    await writeFile(
      join(root, ".story", "config.json"),
      "not json at all",
    );
    const result = await runMcpReadTool(root, handleStatus);
    expect(result.isError).toBe(true);
  });

  it("keeps corrupt-project status errors parseable in JSON format", async () => {
    const root = await setupProject();
    await writeFile(join(root, ".story", "config.json"), "not json at all");
    const result = await runMcpReadTool(root, handleStatus, undefined, "json");
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBeDefined();
    expect(parsed.error.message).toContain("config.json");
  });

  it("handover_latest with handovers present", async () => {
    const root = await setupProject();
    // Create a handover file
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    await writeFile(
      join(handoverDir, "2026-03-20-test.md"),
      "# Test Handover\n\nThis is test content.",
    );
    const result = await runMcpReadTool(root, handleHandoverLatest);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test Handover");
  });

  it("handover_latest with no handovers → not_found (informational)", async () => {
    // Use a fresh project without handovers (not the fixture which has one)
    const dir = await mkdtemp(join(tmpdir(), "mcp-nohandover-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await runMcpReadTool(dir, handleHandoverLatest);
    // not_found is informational, not isError
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No handovers");
  });

  /**
   * T-320: goes through the REAL registered tool (registerAllTools + a live
   * MCP client over InMemoryTransport, callTool), not a hand-built closure --
   * this is what actually exercises the `brief`/`priming` zod schema fields
   * and their forwarding at the tools.ts registration site (mcp/tools.ts
   * ~line 609), which a direct handleHandoverLatest call bypasses entirely.
   */
  async function callHandoverLatest(
    root: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: "handover-latest-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "storybloq_handover_latest", arguments: args });
    await client.close();
    const content = result.content as { text: string }[];
    return { isError: result.isError as boolean | undefined, text: content[0]!.text };
  }

  it("storybloq_handover_latest with brief:true returns a structured digest through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    await writeFile(
      join(handoverDir, "2026-03-20-test.md"),
      "# Handover: test\n\n## Next\n- T-902: keep going\n",
    );
    // T-498: storybloq_handover_latest gained a `format` field (default
    // "md") so a caller needing continuationCandidates/trajectory as data
    // can request "json" explicitly (see the dedicated test below) -- an
    // omitted format still renders through the same default "md" path as
    // before this change.
    const result = await callHandoverLatest(root, { brief: true });
    expect(result.isError).toBeUndefined();
    // formatRecordLine's structured rendering bolds the id; the raw default
    // path never does, so this is a marker unique to the structured form.
    expect(result.text).toContain("**T-902**");
    expect(result.text).not.toContain("## Next\n- T-902: keep going");
  });

  it("storybloq_handover_latest with priming:true returns the raw body verbatim for a small handover through the real MCP registration (T-320/T-497)", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    const body = "# Handover: test\n\n## Next\n- T-903: keep going\n";
    await writeFile(join(handoverDir, "2026-03-20-test.md"), body);
    const result = await callHandoverLatest(root, { priming: true });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain(body);
  });

  it("storybloq_handover_latest with priming:true downgrades an over-trigger body to structured through the real MCP registration -- a discriminating case, since a small body reads the same whether or not priming is actually forwarded", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    const filler = "x".repeat(12_100);
    const body = `# Handover: test\n\n## Next\n- T-905: keep going\n\n${filler}\n`;
    await writeFile(join(handoverDir, "2026-03-20-test.md"), body);
    const result = await callHandoverLatest(root, { priming: true });
    expect(result.isError).toBeUndefined();
    // Structured-only marker (see the brief:true test above); if priming's
    // schema field or its forwarding to handleHandoverLatest were dropped,
    // this handover would fall through to the OLD default raw-body path and
    // the filler (absent from the structured records) would appear verbatim.
    expect(result.text).toContain("**T-905**");
    expect(result.text).not.toContain(filler);
  });

  it("storybloq_handover_latest with brief:true and format:\"json\" returns the full HandoverBriefResult envelope, continuationCandidates included, through the real MCP registration (T-498)", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    await writeFile(
      join(handoverDir, "2026-03-20-test.md"),
      "# Handover: test\n\n## Next\n- T-910: keep going on the thing\n",
    );
    const result = await callHandoverLatest(root, { count: 1, brief: true, format: "json" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text) as {
      version: number;
      data: { handovers: { filename: string; form: string; continuationCandidates?: { candidates: { id: string }[] } }[] };
    };
    expect(parsed.version).toBe(1);
    const first = parsed.data.handovers[0]!;
    expect(first.form).toBe("structured");
    expect(first.continuationCandidates?.candidates.map((c) => c.id)).toContain("T-910");
  });

  it("storybloq_handover_latest with neither flag returns the default raw-body path through the real MCP registration", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    await writeFile(join(handoverDir, "2026-03-20-test.md"), "# Test Handover\n\nThis is test content.");
    const result = await callHandoverLatest(root, {});
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Test Handover");
  });

  /**
   * T-498: storybloq_handover_get also gained a `format` field, for the
   * same reason -- recovery code (scripts/priming-cost.ts's
   * recoverHandoverEvidence) needs to machine-detect a not_found/io_error
   * result via {version, error} vs {version, data}, since not_found is a
   * USER error (never isError:true) and its Markdown text is otherwise
   * indistinguishable from real handover content.
   */
  async function callHandoverGet(
    root: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: "handover-get-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "storybloq_handover_get", arguments: args });
    await client.close();
    const content = result.content as { text: string }[];
    return { isError: result.isError as boolean | undefined, text: content[0]!.text };
  }

  it("storybloq_handover_get with format:\"json\" returns a {version, data} envelope for an existing handover, through the real MCP registration (T-498)", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    await writeFile(join(handoverDir, "2026-03-20-test.md"), "# Test Handover\n\nContent here.");
    const result = await callHandoverGet(root, { filename: "2026-03-20-test.md", format: "json" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text) as { version: number; data: { filename: string; content: string } };
    expect(parsed.version).toBe(1);
    expect(parsed.data.filename).toBe("2026-03-20-test.md");
    expect(parsed.data.content).toContain("Content here.");
  });

  it("storybloq_handover_get with format:\"json\" returns a {version, error} envelope (isError absent) for a missing handover, through the real MCP registration -- proving not_found is machine-detectable via the envelope shape alone, not isError (T-498, Codex round 3 finding)", async () => {
    const root = await setupProject();
    const handoverDir = join(root, ".story", "handovers");
    await mkdir(handoverDir, { recursive: true });
    const result = await callHandoverGet(root, { filename: "does-not-exist.md", format: "json" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text) as { version: number; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("not_found");
  });

  /**
   * T-320 commit 5: same real-registration pattern as callHandoverLatest
   * above -- exercises the storybloq_lesson_digest zod inputSchema's new
   * `limit`/`select` fields and their forwarding at the tools.ts
   * registration site, which a direct handleLessonDigest call bypasses.
   */
  async function callLessonDigest(
    root: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: "lesson-digest-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "storybloq_lesson_digest", arguments: args });
    await client.close();
    const content = result.content as { text: string }[];
    return { isError: result.isError as boolean | undefined, text: content[0]!.text };
  }

  async function writeLesson(root: string, id: string, title: string, tags: string[]): Promise<void> {
    const lessonsDir = join(root, ".story", "lessons");
    await mkdir(lessonsDir, { recursive: true });
    await writeFile(
      join(lessonsDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          title,
          content: "content",
          context: "context",
          source: "manual",
          tags,
          reinforcements: 0,
          lastValidated: "2026-03-27",
          createdDate: "2026-03-27",
          updatedDate: "2026-03-27",
          supersedes: null,
          status: "active",
        },
        null,
        2,
      ) + "\n",
    );
  }

  it("storybloq_lesson_digest with select:[...] filters through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    await writeLesson(root, "L-001", "Matches", ["cli-status"]);
    await writeLesson(root, "L-002", "Excluded", ["other"]);
    const result = await callLessonDigest(root, { select: ["component:cli-status"] });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Matches");
    expect(result.text).not.toContain("Excluded");
  });

  it("storybloq_lesson_digest with limit:N caps through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    await writeLesson(root, "L-001", "First", ["a"]);
    await writeLesson(root, "L-002", "Second", ["b"]);
    const result = await callLessonDigest(root, { limit: 1 });
    expect(result.isError).toBeUndefined();
    const lines = result.text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it("storybloq_lesson_digest with neither flag returns the unchanged default digest through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    await writeLesson(root, "L-001", "Only", ["a"]);
    const result = await callLessonDigest(root, {});
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("# Lessons Learned");
  });

  // Codex R1 finding 2: the zod inputSchema (int().nonnegative()) is what
  // gives the MCP surface the same limit contract as the CLI's own
  // buildLessonDigest-level validation -- proven through the real
  // registration, since a hand-built call to handleLessonDigest bypasses the
  // schema layer entirely.
  it("storybloq_lesson_digest rejects a negative limit at the schema layer through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    await writeLesson(root, "L-001", "Only", ["a"]);
    const result = await callLessonDigest(root, { limit: -1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/greater than or equal to 0/i);
  });

  it("storybloq_lesson_digest rejects a fractional limit at the schema layer through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    await writeLesson(root, "L-001", "Only", ["a"]);
    const result = await callLessonDigest(root, { limit: 1.5 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/integer/i);
  });

  it("storybloq_lesson_digest accepts limit:0 through the real MCP registration (T-320)", async () => {
    const root = await setupProject();
    await writeLesson(root, "L-001", "Only", ["a"]);
    const result = await callLessonDigest(root, { limit: 0 });
    expect(result.isError).toBeUndefined();
  });
});

describe("MCP integration -- phase_create write pipeline", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("storybloq_phase_create -- creates phase via write pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-phase-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await runMcpWriteTool(dir, (root, format) =>
      handlePhaseCreate(
        { id: "alpha", name: "Alpha", label: "PHASE 1", description: "First", after: "p0", atStart: false },
        format, root,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Created phase alpha");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.phases).toHaveLength(2);
    expect(roadmap.phases[1].id).toBe("alpha");
  });

  it("storybloq_phase_create -- duplicate ID returns error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-phase-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await runMcpWriteTool(dir, (root, format) =>
      handlePhaseCreate(
        { id: "p0", name: "Dup", label: "DUP", description: "Dup", after: "p0", atStart: false },
        format, root,
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already exists");
  });

  it("storybloq_phase_create -- missing positioning returns error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-phase-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await runMcpWriteTool(dir, (root, format) =>
      handlePhaseCreate(
        { id: "p1", name: "Test", label: "T", description: "T", atStart: false },
        format, root,
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Must specify");
  });
});

describe("MCP integration -- root pinning", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("rejects non-existent root path", async () => {
    const result = await runMcpReadTool(
      "/tmp/definitely-does-not-exist-storybloq",
      handleStatus,
    );
    expect(result.isError).toBe(true);
  });

  it("works with env var-provided root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-envroot-"));
    tmpDirs.push(dir);
    await cp(FIXTURES_DIR, join(dir, ".story"), { recursive: true });
    // runMcpReadTool takes root directly -- env var is handled by the entry point
    const result = await runMcpReadTool(dir, handleStatus);
    expect(result.isError).toBeUndefined();
  });
});
