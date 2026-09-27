/**
 * T-507 commit B: the roster on `storybloq status`.
 *
 * Non-compact JSON gains `roster` (running seats plus the three counts);
 * Markdown gains one line; the compact payload is untouched, pinned by the
 * exact key list (T-320's schema is a contract). Federated status aggregates
 * the orchestrator's roster with every reachable node's, seats labelled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleStatus } from "../../../src/cli/commands/status.js";
import { formatStatus, formatFederatedStatus } from "../../../src/core/output-formatter.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject, writeConfig } from "../../../src/core/project-loader.js";
import { upsertSeat, ROSTER_STALE_MS } from "../../../src/core/roster.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";
import type { StatusRoster } from "../../../src/core/roster-view.js";
import type { FederationState } from "../../../src/federation/state.js";
import type { Config } from "../../../src/models/config.js";

// The roster readers are wrapped (not replaced) so the compact tests can
// assert they were never entered while every other test still reads for real.
const readers = vi.hoisted(() => ({ withBus: 0, federated: 0 }));
vi.mock("../../../src/core/roster-view.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/roster-view.js")>();
  return {
    ...actual,
    readRosterWithBus: (...args: Parameters<typeof actual.readRosterWithBus>) => { readers.withBus++; return actual.readRosterWithBus(...args); },
    readFederatedRoster: (...args: Parameters<typeof actual.readFederatedRoster>) => { readers.federated++; return actual.readFederatedRoster(...args); },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const start = (clientTaskId: string) => ({ kind: "start" as const, client: "claude" as const, clientTaskId, agentId: null, sessionId: clientTaskId, description: null });

async function project(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `status-roster-${name}-`));
  roots.push(root);
  await initProject(root, { name });
  return root;
}

async function ctxAt(root: string, format: "json" | "md" = "json"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}

const COMPACT_KEYS = [
  "project", "totalTickets", "completeTickets", "openTickets", "blockedTickets", "openIssues", "issueFlow",
  "activeNotes", "activeLessons", "handovers", "isEmptyScaffold", "phases", "activeSessions", "resumableSessions",
  "expiredLeaseSessions", "arrangements", "arrangementWarnings",
];

const sampleRoster: StatusRoster = {
  seats: [{
    schema: "storybloq-roster/v1", seatId: "claude:s1", client: "claude", clientTaskId: "s1", agentId: null, sessionId: "s1",
    description: null, state: "running", provenance: "mod", generation: 1, startedAt: iso(T0), lastSeenAt: iso(T0),
    sourceRefs: { busEndpointIds: [] }, stale: false, node: null,
  }],
  live: 1, stale: 2, terminal: 3, scanTruncated: false, resultTruncated: false, busScanTruncated: false, diagnostics: [],
};

describe("formatStatus and the roster (T-507)", () => {
  it("non-compact JSON carries `roster` when supplied and omits it when not (an absent key means unknown, not empty)", () => {
    const state = makeState();
    const withRoster = JSON.parse(formatStatus(state, "json", [], [], undefined, [], undefined, [], undefined, false, sampleRoster)).data;
    expect(withRoster.roster).toEqual(sampleRoster);
    const without = JSON.parse(formatStatus(state, "json")).data;
    expect("roster" in without).toBe(false);
  });

  it("compact JSON is byte-identical with or without a roster and its key list is exactly T-320's", () => {
    const state = makeState();
    const a = formatStatus(state, "json", [], [], undefined, [], undefined, [], undefined, true);
    const b = formatStatus(state, "json", [], [], undefined, [], undefined, [], undefined, true, sampleRoster);
    expect(b).toBe(a);
    expect(Object.keys(JSON.parse(a).data)).toEqual(COMPACT_KEYS);
  });

  it("Markdown prints exactly one Seats line, with the stale count, and none without a roster", () => {
    const state = makeState();
    const md = formatStatus(state, "md", [], [], undefined, [], undefined, [], undefined, false, sampleRoster);
    const seatLines = md.split("\n").filter((l) => l.startsWith("Seats:"));
    expect(seatLines).toEqual(["Seats: 1 live, 2 stale"]);
    expect(formatStatus(state, "md")).not.toContain("Seats:");
  });

  it("Markdown qualifies a cut or degraded roster and names an unreadable one, never presenting partial counts as whole", () => {
    const state = makeState();
    const line = (roster: StatusRoster) => formatStatus(state, "md", [], [], undefined, [], undefined, [], undefined, false, roster).split("\n").filter((l) => l.startsWith("Seats:"));
    expect(line({ ...sampleRoster, busScanTruncated: true })).toEqual(["Seats: 1 live, 2 stale (partial; see roster list)"]);
    expect(line({ ...sampleRoster, scanTruncated: true })).toEqual(["Seats: 1 live, 2 stale (partial; see roster list)"]);
    expect(line({ ...sampleRoster, resultTruncated: true })).toEqual(["Seats: 1 live, 2 stale (partial; see roster list)"]);
    expect(line({ ...sampleRoster, diagnostics: ["alpha: config unreadable (x), Bus not consulted"] })).toEqual(["Seats: 1 live, 2 stale (partial; see roster list)"]);
    const empty: StatusRoster = { seats: [], live: 0, stale: 0, terminal: 0, scanTruncated: false, resultTruncated: false, busScanTruncated: false, diagnostics: [] };
    expect(line({ ...empty, diagnostics: ["roster unreadable: EACCES"] })).toEqual(["Seats: unknown (roster unreadable; see roster list)"]);
    // An empty roster with only a Bus diagnostic is empty and partial, not unreadable.
    expect(line({ ...empty, diagnostics: ["bus runtime not initialised (no endpoints directory); Bus seats not merged"] })).toEqual(["Seats: 0 live, 0 stale (partial; see roster list)"]);
    expect(line(empty)).toEqual(["Seats: 0 live, 0 stale"]);
  });

  it("compact status never reads the roster: the payload is identical and the roster directory is untouched", async () => {
    const root = await project("compact");
    const rosterDir = join(root, ".story", "telemetry", "roster");
    expect(existsSync(rosterDir)).toBe(false);
    const before = { ...readers };
    const compact = JSON.parse((await handleStatus(await ctxAt(root), null, { compact: true })).output).data;
    expect(readers).toEqual(before);
    expect("roster" in compact).toBe(false);
    expect(Object.keys(compact).every((k) => COMPACT_KEYS.includes(k) || k === "sessionDiagnostics" || k === "bus")).toBe(true);
    expect(existsSync(rosterDir)).toBe(false);
    expect(existsSync(join(root, ".story", "telemetry"))).toBe(false);
    // The non-compact read of the same project does enter the reader (the wrap is live).
    await handleStatus(await ctxAt(root));
    expect(readers.withBus).toBe(before.withBus + 1);
  });
});

describe("handleStatus reads the roster from disk", () => {
  it("single project: running seats in JSON with counts, terminal hidden but counted; Markdown line present", async () => {
    const root = await project("single");
    upsertSeat(root, start("live"), iso(Date.now()));
    upsertSeat(root, start("stale"), iso(Date.now() - ROSTER_STALE_MS - 1000));
    upsertSeat(root, start("done"), iso(Date.now()));
    upsertSeat(root, { kind: "end", state: "failed", generation: 1, client: "claude", clientTaskId: "done", agentId: null }, iso(Date.now()));
    const parsed = JSON.parse((await handleStatus(await ctxAt(root))).output).data;
    expect(parsed.roster.seats.map((s: { seatId: string }) => s.seatId).sort()).toEqual(["claude:live", "claude:stale"]);
    expect(parsed.roster).toMatchObject({ live: 1, stale: 1, terminal: 1 });
    const md = (await handleStatus(await ctxAt(root, "md"))).output;
    expect(md).toContain("Seats: 1 live, 1 stale");
  });

  it("no roster directory at all: an empty roster with zero counts, and nothing created", async () => {
    const root = await project("empty");
    const rosterDir = join(root, ".story", "telemetry", "roster");
    expect(existsSync(rosterDir)).toBe(false);
    const parsed = JSON.parse((await handleStatus(await ctxAt(root))).output).data;
    expect(parsed.roster).toEqual({ seats: [], live: 0, stale: 0, terminal: 0, scanTruncated: false, resultTruncated: false, busScanTruncated: false, diagnostics: [] });
    expect(existsSync(rosterDir)).toBe(false);
    expect(existsSync(join(root, ".story", "telemetry"))).toBe(false);
  });

  it("orchestrator compact status never reads any roster: no telemetry dir appears on the root or the node and no roster key", async () => {
    const nodeRoot = await project("node-compact");
    const root = mkdtempSync(join(tmpdir(), "status-roster-orch-compact-"));
    roots.push(root);
    await initProject(root, { name: "orchestrator", type: "orchestrator" });
    const { state } = await loadProject(root);
    await writeConfig({
      ...state.config,
      nodes: { engine: { path: nodeRoot, health: "grey", dependsOn: [], stack: "", role: "", summary: "" } },
    } as typeof state.config, root);
    const before = { ...readers };
    const compact = JSON.parse((await handleStatus(await ctxAt(root), null, { compact: true })).output).data;
    expect(readers).toEqual(before);
    expect("roster" in compact).toBe(false);
    expect(existsSync(join(root, ".story", "telemetry"))).toBe(false);
    expect(existsSync(join(nodeRoot, ".story", "telemetry"))).toBe(false);
    // The non-compact orchestrator read enters the federated reader exactly once.
    await handleStatus(await ctxAt(root));
    expect(readers.federated).toBe(before.federated + 1);
  });

  it("orchestrator: the federated payload aggregates the root and each node, seats labelled by node", async () => {
    const nodeRoot = await project("node");
    upsertSeat(nodeRoot, start("node-seat"), iso(Date.now()));
    const root = mkdtempSync(join(tmpdir(), "status-roster-orch-"));
    roots.push(root);
    await initProject(root, { name: "orchestrator", type: "orchestrator" });
    const { state } = await loadProject(root);
    await writeConfig({
      ...state.config,
      nodes: { engine: { path: nodeRoot, health: "grey", dependsOn: [], stack: "", role: "", summary: "" } },
    } as typeof state.config, root);
    upsertSeat(root, start("orch-seat"), iso(Date.now()));
    const parsed = JSON.parse((await handleStatus(await ctxAt(root))).output).data;
    expect(parsed.roster.seats.map((s: { node: string | null; seatId: string }) => [s.node, s.seatId]).sort()).toEqual([
      ["engine", "claude:node-seat"],
      [null, "claude:orch-seat"],
    ].sort());
    expect(parsed.roster.live).toBe(2);
    const md = (await handleStatus(await ctxAt(root, "md"))).output;
    expect(md).toContain("Seats: 2 live, 0 stale");
  });
});

describe("formatFederatedStatus and the roster", () => {
  const fedState: FederationState = {
    orchestratorProject: "orch", nodeCount: 0, reachableCount: 0, unreachableCount: 0,
    totalTickets: 0, totalCompleteTickets: 0, totalOpenIssues: 0, nodes: [],
  } as unknown as FederationState;
  const config = { project: "orch", type: "orchestrator", features: {}, recipeOverrides: {} } as unknown as Config;

  it("JSON carries `roster` when supplied; Markdown prints the Seats line", () => {
    const json = JSON.parse(formatFederatedStatus(fedState, config, "json", [], [], undefined, [], undefined, [], undefined, sampleRoster)).data;
    expect(json.roster).toEqual(sampleRoster);
    expect("roster" in JSON.parse(formatFederatedStatus(fedState, config, "json")).data).toBe(false);
    const md = formatFederatedStatus(fedState, config, "md", [], [], undefined, [], undefined, [], undefined, sampleRoster);
    expect(md.split("\n").filter((l) => l.startsWith("Seats:"))).toEqual(["Seats: 1 live, 2 stale"]);
  });
});
