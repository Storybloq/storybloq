/**
 * T-486 U2-4: end-to-end cases 1 to 5 (V3A 5c) with separate node and
 * orchestrator ledgers, through the real scanner, cache write and live
 * observation, and the real command handlers.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { handleStatus } from "../../src/cli/commands/status.js";
import { handleRecommend } from "../../src/cli/commands/recommend.js";
import { handleValidateWithSourceRefs } from "../../src/cli/commands/validate.js";
import { handleTicketBlocked, handleTicketGet } from "../../src/cli/commands/ticket.js";
import { handleIssueGet } from "../../src/cli/commands/issue.js";
import { handleDispatch } from "../../src/cli/commands/dispatch.js";
import { readFederationCache } from "../../src/federation/cache.js";
import type { CommandContext } from "../../src/cli/types.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u24-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Raw = Record<string, unknown>;
const DONE = "2026-02-01";
function ticket(id: string, extra: Raw = {}): Raw {
  return {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  };
}
const delivered = (id: string, extra: Raw = {}) => ticket(id, { status: "complete", completedDate: DONE, ...extra });
const withdrawn = (id: string, extra: Raw = {}) =>
  delivered(id, { resolutionKind: { kind: "withdrawn", closedOn: DONE, reason: "Superseded." }, ...extra });

function writeTickets(root: string, bodies: Raw[]): void {
  for (const b of bodies) writeFileSync(join(root, ".story", "tickets", `${String(b.id)}.json`), JSON.stringify(b));
}

/** A node ledger "cpm" and an orchestrator whose T-7 is blocked by `cpm:<ref>`. */
async function federation(nodeTickets: Raw[], ref: string): Promise<{ orch: string; node: string }> {
  const node = mkdtempSync(join(tmpdir(), "t486-u24-node-"));
  const orch = mkdtempSync(join(tmpdir(), "t486-u24-orch-"));
  dirs.push(node, orch);
  await initProject(node, { name: "cpm" });
  writeTickets(node, nodeTickets);
  await initProject(orch, { name: "orch" });
  writeFileSync(join(orch, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 2, project: "orch", type: "orchestrator", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    nodes: { cpm: { path: node, health: "grey", dependsOn: [], stack: "", role: "", summary: "" } },
  }));
  writeTickets(orch, [ticket("T-7", { crossNodeBlockedBy: [`cpm:${ref}`] })]);
  mkdirSync(join(orch, ".story", "issues"), { recursive: true });
  writeFileSync(join(orch, ".story", "issues", "ISS-001.json"), JSON.stringify({
    id: "ISS-001", title: "An issue", status: "open", severity: "low", components: [], impact: "", resolution: null,
    location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: ["T-7"],
  }));
  return { orch, node };
}

async function ctxAt(root: string, format: "md" | "json" = "json"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}

async function scan(orch: string): Promise<void> {
  await handleStatus(await ctxAt(orch));
}

async function recommendations(orch: string): Promise<Array<{ id: string; kind: string; category: string; title: string; reason: string }>> {
  return JSON.parse((await handleRecommend(await ctxAt(orch), 20)).output).data.recommendations;
}

async function validateFindings(orch: string): Promise<Array<{ code: string; message: string }>> {
  return JSON.parse((await handleValidateWithSourceRefs(await ctxAt(orch))).output).data.findings;
}

async function blockedText(orch: string): Promise<string> {
  return (await handleTicketBlocked(await ctxAt(orch, "md"))).output;
}

const retargets = (recs: Awaited<ReturnType<typeof recommendations>>) => recs.filter((r) => r.category === "cross_node_withdrawn");

describe("T-486 U2-4: cross-node end to end, separate ledgers", () => {
  it("E2E 1: withdrawn target: recommend omits the dependent and emits cross_node_withdrawn, validate warns, ticket blocked names node, target and action", async () => {
    const { orch } = await federation([withdrawn("T-4")], "T-4");
    await scan(orch);
    const recs = await recommendations(orch);
    expect(recs.some((r) => r.kind === "ticket" && r.id === "T-7")).toBe(false);
    expect(retargets(recs)).toHaveLength(1);
    expect(retargets(recs)[0]!.title).toBe("Retarget T-7: its cross-node blocker cpm:T-4 was withdrawn");
    const warn = (await validateFindings(orch)).filter((f) => f.code === "cross_node_withdrawn");
    expect(warn.map((f) => f.message)).toEqual([`T-7: crossNodeBlockedBy cpm:T-4 is withdrawn in node "cpm"; retarget or remove the edge`]);
    const text = await blockedText(orch);
    expect(text).toContain("T-7");
    expect(text).toContain("cpm:T-4 (withdrawn");
    expect(text).toContain("retarget");
  });

  it("E2E 1, through the built CLI: validate warns from a fresh process", async () => {
    const { orch } = await federation([withdrawn("T-4")], "T-4");
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");
    expect(existsSync(cli)).toBe(true);
    const out = execFileSync(process.execPath, [cli, "validate", "--format", "json"], {
      cwd: orch, env: { HOME: scratchHome, PATH: dirname(process.execPath) + ":/usr/bin:/bin" }, encoding: "utf8",
    });
    const findings = JSON.parse(out).data.findings as Array<{ code: string }>;
    expect(findings.filter((f) => f.code === "cross_node_withdrawn")).toHaveLength(1);
  });

  it("E2E 2: remote umbrella with a withdrawn descendant: withheld, dependent blocked, action names the descendant", async () => {
    const { orch } = await federation([delivered("T-2"), delivered("T-3", { parentTicket: "T-2" }), withdrawn("T-4", { parentTicket: "T-2" })], "T-2");
    await scan(orch);
    const recs = await recommendations(orch);
    expect(recs.some((r) => r.kind === "ticket" && r.id === "T-7")).toBe(false);
    expect(retargets(recs).map((r) => r.title)).toEqual(["Retarget T-7: its cross-node blocker cpm:T-2 has withdrawn work under it (T-4)"]);
    expect(await blockedText(orch)).toContain("cpm:T-2 (withheld");
  });

  it("E2E 3: withdrawal cleared after the scan, cache still says withdrawn: no action, no warning", async () => {
    const { orch, node } = await federation([withdrawn("T-4")], "T-4");
    await scan(orch);
    expect(readFederationCache(join(orch, ".story"))?.crossNodeRefStatuses?.["cpm:T-4"]).toBe("withdrawn");
    writeTickets(node, [delivered("T-4")]);
    const recs = await recommendations(orch);
    expect(retargets(recs)).toEqual([]);
    expect(recs.some((r) => r.kind === "ticket" && r.id === "T-7")).toBe(true);
    expect((await validateFindings(orch)).filter((f) => f.code === "cross_node_withdrawn")).toEqual([]);
    expect(await blockedText(orch)).not.toContain("T-7");
    // dispatch --dry-run runs on the same live observation without error.
    const plan = await handleDispatch(await ctxAt(orch), { ids: "all", count: 3, dryRun: true, yes: false });
    expect(plan.exitCode ?? 0).toBe(0);
  });

  it("E2E 4: node path changed after the scan: unresolved, no action", async () => {
    const { orch, node } = await federation([withdrawn("T-4")], "T-4");
    await scan(orch);
    renameSync(node, `${node}-moved`);
    dirs.push(`${node}-moved`);
    const recs = await recommendations(orch);
    expect(retargets(recs)).toEqual([]);
    expect(recs.some((r) => r.kind === "ticket" && r.id === "T-7")).toBe(false);
    expect((await validateFindings(orch)).filter((f) => f.code === "cross_node_withdrawn")).toEqual([]);
    expect(await blockedText(orch)).toContain("cpm:T-4 (unresolved");
  });

  it("E2E 5: target unreachable: unresolved with the reason, cached value labelled stale", async () => {
    const { orch, node } = await federation([withdrawn("T-4")], "T-4");
    await scan(orch);
    const scannedAt = readFederationCache(join(orch, ".story"))!.lastScanTimestamp;
    rmSync(join(node, ".story", "tickets"), { recursive: true });
    writeFileSync(join(node, ".story", "tickets"), "not a directory");
    expect(retargets(await recommendations(orch))).toEqual([]);
    const text = await blockedText(orch);
    expect(text).toContain("cpm:T-4 (unresolved: scan error");
    expect(text).toContain(`cached withdrawn, stale (scanned ${scannedAt})`);
  });

  it("A-live: ticket get and issue get actionability agree with ticket blocked for a withdrawn target whose cache still says complete", async () => {
    const { orch, node } = await federation([delivered("T-4")], "T-4");
    await scan(orch);
    expect(readFederationCache(join(orch, ".story"))?.crossNodeRefStatuses?.["cpm:T-4"]).toBe("complete");
    writeTickets(node, [withdrawn("T-4")]);
    const got = JSON.parse((await handleTicketGet("T-7", await ctxAt(orch), true)).output).data;
    expect(got.actionability.status).toBe("blocked");
    expect(await blockedText(orch)).toContain("T-7");
    const issue = JSON.parse((await handleIssueGet("ISS-001", await ctxAt(orch), true)).output).data;
    expect(issue.actionability.status).toBe("actionable");
  });
});
