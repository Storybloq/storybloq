/**
 * T-507 commit B: the roster as status and the CLI read it, Bus merged.
 *
 * `core/roster.ts` is pure over records and endpoint projections; this layer
 * owns the Bus read (endpoints and their liveness), the status projection
 * (running seats only, terminal counted but hidden) and the federated
 * aggregation (root plus every reachable node, each seat labelled).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../src/core/init.js";
import { loadProject, writeConfig } from "../../src/core/project-loader.js";
import { upsertSeat, ROSTER_STALE_MS, ROSTER_SCAN_CAP, ROSTER_RESULT_CAP } from "../../src/core/roster.js";
import { readRosterWithBus, statusRosterFrom, readFederatedRoster, type LivenessProbe } from "../../src/core/roster-view.js";
import { joinEndpoint } from "../../src/bus/endpoints.js";
import { initializeBus } from "../../src/bus/admin.js";
import type { BusEndpoint } from "../../src/bus/schemas.js";
import type { Config } from "../../src/models/config.js";
import { handleRosterList, rosterListMarkdown } from "../../src/cli/commands/roster.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function project(name: string, bus = false): Promise<{ root: string; config: Config }> {
  const root = mkdtempSync(join(tmpdir(), `roster-view-${name}-`));
  roots.push(root);
  await initProject(root, { name });
  let { state } = await loadProject(root);
  if (bus) {
    await writeConfig({ ...state.config, features: { ...state.config.features, bus: true } }, root);
    state = (await loadProject(root)).state;
  }
  return { root, config: state.config };
}

const T0 = Date.parse("2026-09-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const seatStart = (clientTaskId: string, over: Partial<{ agentId: string | null; sessionId: string; client: "claude" | "codex" }> = {}) =>
  ({ kind: "start" as const, client: over.client ?? ("claude" as const), clientTaskId, agentId: over.agentId ?? null, sessionId: over.sessionId ?? clientTaskId, description: null });

describe("readRosterWithBus", () => {
  it("without the Bus feature reads the records alone: a joined endpoint is neither probed nor merged", async () => {
    // The runtime exists (initialised and joined) but the config handed in has
    // the feature off: the read must not consult it at all.
    const { root, config } = await project("plain", true);
    await initializeBus(root);
    await joinEndpoint(root, { client: "claude", clientTaskId: "bus-only", surface: "claude_cli" });
    expect(upsertSeat(root, seatStart("task-a"), iso(T0)).ok).toBe(true);
    const probed: string[] = [];
    const probe: LivenessProbe = async (e) => { probed.push(e.endpointId); return "attached"; };
    const off = { ...config, features: { ...config.features, bus: false } } as Config;
    const view = await readRosterWithBus(root, off, T0 + 1, probe);
    expect(view.seats.map((s) => s.seatId)).toEqual(["claude:task-a"]);
    expect(view.seats[0]!.provenance).toBe("mod");
    expect(view.busScanTruncated).toBe(false);
    expect(view.diagnostics).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("with the Bus on, an attached endpoint with no mod seat is a synthesized bus seat and a dead one is nothing", async () => {
    const { root, config } = await project("bus", true);
    await initializeBus(root);
    const live = (await joinEndpoint(root, { client: "claude", clientTaskId: "bus-live", surface: "claude_cli" })).endpoint;
    const dead = (await joinEndpoint(root, { client: "codex", clientTaskId: "bus-dead", surface: "codex_cli" })).endpoint;
    const deadPath = join(root, ".story", "bus", "endpoints", `${dead.endpointId}.json`);
    writeFileSync(deadPath, JSON.stringify({ ...dead, state: "attached", processRef: { pid: 2147483000, signature: "darwin:dead", capturedAt: iso(T0) } }));
    const view = await readRosterWithBus(root, config, Date.now());
    const ids = view.seats.map((s) => s.seatId);
    expect(ids).toContain("claude:bus-live");
    expect(ids).not.toContain("codex:bus-dead");
    const seat = view.seats.find((s) => s.seatId === "claude:bus-live")!;
    expect(seat.provenance).toBe("bus");
    expect(seat.sourceRefs.busEndpointIds).toEqual([live.endpointId]);
  });

  it("a Bus read failure is a diagnostic on the view, never a thrown status", async () => {
    const { root, config } = await project("busbroken", true);
    upsertSeat(root, seatStart("task-a"), iso(T0));
    // The Bus feature is on but no runtime was ever initialised: the read must
    // still return the mod seat and say why the Bus contributed nothing.
    const view = await readRosterWithBus(root, config, T0 + 1);
    expect(view.seats.map((s) => s.seatId)).toEqual(["claude:task-a"]);
    expect(view.diagnostics.some((d) => d.toLowerCase().includes("bus"))).toBe(true);
  });

  it("a retired endpoint is never probed; the attached one is probed exactly once", async () => {
    const { root, config } = await project("retired", true);
    await initializeBus(root);
    const live = (await joinEndpoint(root, { client: "claude", clientTaskId: "bus-live", surface: "claude_cli" })).endpoint;
    const retired = cloneEndpoint(root, live, { clientTaskId: "bus-retired", retiredAt: iso(T0) });
    const probed: string[] = [];
    const probe: LivenessProbe = async (e) => { probed.push(e.endpointId); return "attached"; };
    const view = await readRosterWithBus(root, config, Date.now(), probe);
    expect(probed).toEqual([live.endpointId]);
    expect(view.seats.map((s) => s.seatId)).toEqual(["claude:bus-live"]);
    expect(view.seats.some((s) => s.sourceRefs.busEndpointIds.includes(retired.endpointId))).toBe(false);
  });

  it("Bus endpoints are scanned up to ROSTER_SCAN_CAP: at the cap nothing is cut, one past it busScanTruncated is true and the probe count stays at the cap", async () => {
    const { root, config } = await project("buscap", true);
    await initializeBus(root);
    const seed = (await joinEndpoint(root, { client: "claude", clientTaskId: "seed", surface: "claude_cli" })).endpoint;
    for (let i = 1; i < ROSTER_SCAN_CAP; i++) cloneEndpoint(root, seed, { clientTaskId: `ep-${i}` });
    let probed = 0;
    const probe: LivenessProbe = async () => { probed++; return "attached"; };
    const atCap = await readRosterWithBus(root, config, Date.now(), probe);
    expect(atCap.busScanTruncated).toBe(false);
    expect(probed).toBe(ROSTER_SCAN_CAP);
    // The overflow file sorts LAST by name and is not JSON: the bounded
    // listing must never open it, so no "skipped" diagnostic may appear.
    writeFileSync(join(root, ".story", "bus", "endpoints", "zzzzzzzz-ffff-ffff-ffff-ffffffffffff.json"), "{not json");
    probed = 0;
    const past = await readRosterWithBus(root, config, Date.now(), probe);
    expect(past.busScanTruncated).toBe(true);
    expect(probed).toBe(ROSTER_SCAN_CAP);
    expect(past.diagnostics.filter((d) => d.startsWith("bus endpoint skipped:"))).toEqual([]);
    // The cut also reaches the status projection (the reviewer's point: status
    // must never present a capped scan as the population).
    expect(statusRosterFrom(past, null).busScanTruncated).toBe(true);
    expect(statusRosterFrom(atCap, null).busScanTruncated).toBe(false);
  });
});

/** A second endpoint record shaped exactly like a joined one, under its own id and filename. */
function cloneEndpoint(root: string, base: BusEndpoint, over: Partial<BusEndpoint>): BusEndpoint {
  const endpoint = { ...base, ...over, endpointId: randomUUID() } as BusEndpoint;
  writeFileSync(join(root, ".story", "bus", "endpoints", `${endpoint.endpointId}.json`), JSON.stringify(endpoint));
  return endpoint;
}

describe("statusRosterFrom", () => {
  it("keeps running seats (live and stale), counts terminal ones and hides them, and labels the node", async () => {
    const { root, config } = await project("status");
    upsertSeat(root, seatStart("live"), iso(T0 + ROSTER_STALE_MS));
    upsertSeat(root, seatStart("stale"), iso(T0));
    upsertSeat(root, seatStart("done"), iso(T0 + ROSTER_STALE_MS));
    upsertSeat(root, { kind: "end", state: "completed", generation: 1, client: "claude", clientTaskId: "done", agentId: null }, iso(T0 + ROSTER_STALE_MS));
    const view = await readRosterWithBus(root, config, T0 + ROSTER_STALE_MS + 1);
    const status = statusRosterFrom(view, null);
    expect(status.seats.map((s) => s.seatId).sort()).toEqual(["claude:live", "claude:stale"]);
    expect(status.seats.every((s) => s.node === null)).toBe(true);
    expect(status.live).toBe(1);
    expect(status.stale).toBe(1);
    expect(status.terminal).toBe(1);
    expect(status.seats.find((s) => s.seatId === "claude:stale")!.stale).toBe(true);
    // The ledger did not forget the terminal seat: the full view still lists it.
    expect(view.seats.some((s) => s.seatId === "claude:done")).toBe(true);
  });
});

describe("readFederatedRoster", () => {
  it("aggregates the orchestrator's roster with every resolved node's, each seat labelled by node, bounded and flagged", async () => {
    const { root, config } = await project("orch");
    const nodeA = await project("node-a");
    const nodeB = await project("node-b");
    upsertSeat(root, seatStart("orch-seat"), iso(T0));
    upsertSeat(nodeA.root, seatStart("a-seat"), iso(T0 + 1));
    upsertSeat(nodeB.root, seatStart("b-seat"), iso(T0 + 2));
    const nodes = new Map([
      ["alpha", { resolved: true as const, absolutePath: nodeA.root, storyDir: join(nodeA.root, ".story"), rawPath: nodeA.root }],
      ["beta", { resolved: true as const, absolutePath: nodeB.root, storyDir: join(nodeB.root, ".story"), rawPath: nodeB.root }],
      ["gone", { resolved: false as const, reason: "missing", rawPath: "/nowhere" }],
    ]);
    const fed = await readFederatedRoster(root, config, nodes, T0 + 3);
    expect(fed.seats.map((s) => [s.node, s.seatId])).toEqual([
      ["beta", "claude:b-seat"],
      ["alpha", "claude:a-seat"],
      [null, "claude:orch-seat"],
    ]);
    expect(fed.live).toBe(3);
    expect(fed.terminal).toBe(0);
    expect(fed.resultTruncated).toBe(false);
    expect(fed.busScanTruncated).toBe(false);
    expect(fed.diagnostics).toEqual(["gone: node not resolved (missing), roster not read"]);
  });

  it("every node's diagnostic carries that node's exact prefix; the root's carries none", async () => {
    const { root, config } = await project("orch-diag", true);
    // Root: Bus on, never initialised -> the root diagnostic, unprefixed.
    const badA = badConfigNode("a"); const badB = badConfigNode("b");
    const nodes = new Map([
      ["alpha", { resolved: true as const, absolutePath: badA, storyDir: join(badA, ".story"), rawPath: badA }],
      ["beta", { resolved: true as const, absolutePath: badB, storyDir: join(badB, ".story"), rawPath: badB }],
      ["gamma", { resolved: false as const, reason: "outside", rawPath: "/nowhere" }],
    ]);
    const fed = await readFederatedRoster(root, config, nodes, T0);
    expect(fed.diagnostics[0]).toBe("bus runtime not initialised (no endpoints directory); Bus seats not merged");
    expect(fed.diagnostics[1]).toMatch(/^alpha: config unreadable \(.+\), Bus not consulted$/);
    expect(fed.diagnostics[2]).toMatch(/^beta: config unreadable \(.+\), Bus not consulted$/);
    expect(fed.diagnostics[3]).toBe("gamma: node not resolved (outside), roster not read");
    expect(fed.diagnostics).toHaveLength(4);
  });

  it("a node whose config is unreadable still contributes its roster records (readRoster fallback), labelled, and no roster dir is created", async () => {
    const { root, config } = await project("orch2");
    const nodeDir = badConfigNode("seat");
    // A seat written BEFORE the config is corrupted: the fallback must still read it.
    expect(upsertSeat(nodeDir, seatStart("node-seat"), iso(T0)).ok).toBe(true);
    const emptyDir = badConfigNode("empty");
    const nodes = new Map([
      ["bad", { resolved: true as const, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ["bare", { resolved: true as const, absolutePath: emptyDir, storyDir: join(emptyDir, ".story"), rawPath: emptyDir }],
    ]);
    const fed = await readFederatedRoster(root, config, nodes, T0 + 1);
    expect(fed.seats.map((s) => [s.node, s.seatId])).toEqual([["bad", "claude:node-seat"]]);
    expect(fed.live).toBe(1);
    expect(fed.diagnostics.filter((d) => d.startsWith("bad: config unreadable ("))).toHaveLength(1);
    expect(existsSync(join(emptyDir, ".story", "telemetry", "roster"))).toBe(false);
  });

  it("the federated result is bounded to ROSTER_RESULT_CAP overall, newest first, and says so; exactly the cap is not a cut", async () => {
    const { root, config } = await project("orch-cap");
    const nodeA = await project("node-cap");
    const half = ROSTER_RESULT_CAP / 2;
    for (let i = 0; i < half; i++) expect(upsertSeat(root, seatStart(`r-${i}`), iso(T0 + i)).ok).toBe(true);
    for (let i = 0; i < half; i++) expect(upsertSeat(nodeA.root, seatStart(`n-${i}`), iso(T0 + 1000 + i)).ok).toBe(true);
    const nodes = new Map([["alpha", { resolved: true as const, absolutePath: nodeA.root, storyDir: join(nodeA.root, ".story"), rawPath: nodeA.root }]]);
    const exact = await readFederatedRoster(root, config, nodes, T0 + 5000);
    expect(exact.seats).toHaveLength(ROSTER_RESULT_CAP);
    expect(exact.resultTruncated).toBe(false);
    expect(upsertSeat(root, seatStart("r-newest"), iso(T0 + 9000)).ok).toBe(true);
    const over = await readFederatedRoster(root, config, nodes, T0 + 9001);
    expect(over.seats).toHaveLength(ROSTER_RESULT_CAP);
    expect(over.resultTruncated).toBe(true);
    expect(over.live).toBe(ROSTER_RESULT_CAP + 1);
    // Newest first: the new root seat leads, then every node seat, then the root ones; the oldest root seat is the one cut.
    expect(over.seats[0]).toMatchObject({ node: null, seatId: "claude:r-newest" });
    expect(over.seats.slice(1, half + 1).every((s) => s.node === "alpha")).toBe(true);
    expect(over.seats.some((s) => s.seatId === "claude:r-0")).toBe(false);
  });
});

describe("nodeConfig hardening (through readFederatedRoster)", () => {
  it("a symlinked or oversized node config is a diagnostic and the node's roster is still read", async () => {
    const { root, config } = await project("orch-hard");
    const linked = mkdtempSync(join(tmpdir(), "roster-view-linked-"));
    roots.push(linked);
    mkdirSync(join(linked, ".story"), { recursive: true });
    writeFileSync(join(linked, "real.json"), JSON.stringify({ features: { bus: true } }));
    symlinkSync(join(linked, "real.json"), join(linked, ".story", "config.json"));
    expect(upsertSeat(linked, seatStart("linked-seat"), iso(T0)).ok).toBe(true);
    const huge = mkdtempSync(join(tmpdir(), "roster-view-huge-"));
    roots.push(huge);
    mkdirSync(join(huge, ".story"), { recursive: true });
    writeFileSync(join(huge, ".story", "config.json"), JSON.stringify({ features: {}, pad: "x".repeat(300 * 1024) }));
    const nodes = new Map([
      ["linked", { resolved: true as const, absolutePath: linked, storyDir: join(linked, ".story"), rawPath: linked }],
      ["huge", { resolved: true as const, absolutePath: huge, storyDir: join(huge, ".story"), rawPath: huge }],
    ]);
    const fed = await readFederatedRoster(root, config, nodes, T0 + 1);
    expect(fed.seats.map((s) => [s.node, s.seatId])).toEqual([["linked", "claude:linked-seat"]]);
    expect(fed.diagnostics).toEqual([
      "linked: config unreadable (config.json is missing, not a regular file, or exceeds the size bound), Bus not consulted",
      "huge: config unreadable (config.json is missing, not a regular file, or exceeds the size bound), Bus not consulted",
    ]);
  });
});

/** A node directory whose .story/config.json is not JSON. */
function badConfigNode(tag: string): string {
  const nodeDir = mkdtempSync(join(tmpdir(), `roster-view-badnode-${tag}-`));
  roots.push(nodeDir);
  mkdirSync(join(nodeDir, ".story"), { recursive: true });
  writeFileSync(join(nodeDir, ".story", "config.json"), "{not json");
  return nodeDir;
}

describe("readRosterWithBus: structured read uncertainty (ISS-1290)", () => {
  it("V1: a probe that throws and a probe that reads unknown are each kept as bus-probe uncertainty with identity; seats are as before", async () => {
    const { root, config } = await project("probe-unknown", true);
    await initializeBus(root);
    const a = (await joinEndpoint(root, { client: "codex", clientTaskId: "task-throws", surface: "codex_cli" })).endpoint;
    const b = (await joinEndpoint(root, { client: "codex", clientTaskId: "task-unknown", surface: "codex_cli" })).endpoint;
    const probe: LivenessProbe = async (e) => {
      if (e.endpointId === a.endpointId) throw new Error("probe failed");
      return "unknown";
    };
    const view = await readRosterWithBus(root, config, Date.now(), probe);
    expect(view.seats).toEqual([]);
    expect(view.live).toBe(0);
    const entries = [...(view.readUncertainty ?? [])].sort((x, y) => (x.endpointId ?? "").localeCompare(y.endpointId ?? ""));
    const expected = [
      { source: "bus-probe", cause: "probe threw", identity: { client: "codex", clientTaskId: "task-throws" }, endpointId: a.endpointId },
      { source: "bus-probe", cause: "unknown", identity: { client: "codex", clientTaskId: "task-unknown" }, endpointId: b.endpointId },
    ].sort((x, y) => x.endpointId.localeCompare(y.endpointId));
    expect(entries).toEqual(expected);
  });

  it("V2: a retired endpoint, the Bus disabled, and an uninitialised Bus add no uncertainty", async () => {
    const { root, config } = await project("no-uncertainty", true);
    expect("readUncertainty" in (await readRosterWithBus(root, config, Date.now(), async () => "unknown"))).toBe(false);
    await initializeBus(root);
    const live = (await joinEndpoint(root, { client: "claude", clientTaskId: "bus-live", surface: "claude_cli" })).endpoint;
    cloneEndpoint(root, live, { clientTaskId: "bus-retired", retiredAt: iso(T0) });
    const probe: LivenessProbe = async () => "attached";
    expect("readUncertainty" in (await readRosterWithBus(root, config, Date.now(), probe))).toBe(false);
    const off = { ...config, features: { ...config.features, bus: false } } as Config;
    expect("readUncertainty" in (await readRosterWithBus(root, off, Date.now(), async () => "unknown"))).toBe(false);
  });

  it("V3: an unreadable endpoint file is a bus-endpoint uncertainty", async () => {
    const { root, config } = await project("endpoint-garbage", true);
    await initializeBus(root);
    writeFileSync(join(root, ".story", "bus", "endpoints", `${randomUUID()}.json`), "{ not json");
    const view = await readRosterWithBus(root, config, Date.now(), async () => "attached");
    expect(view.readUncertainty?.map((u) => u.source)).toEqual(["bus-endpoint"]);
  });

  it("V5: an endpoint-named symlink is a bus-endpoint uncertainty, never followed; diagnostics are unchanged", async () => {
    const { root, config } = await project("endpoint-symlink", true);
    await initializeBus(root);
    const endpoint = (await joinEndpoint(root, { client: "codex", clientTaskId: "linked-task", surface: "codex_cli" })).endpoint;
    const probed: string[] = [];
    const probe: LivenessProbe = async (e) => { probed.push(e.endpointId); return "attached"; };
    const clean = await readRosterWithBus(root, config, Date.now(), probe);
    const elsewhere = mkdtempSync(join(tmpdir(), "endpoint-elsewhere-"));
    roots.push(elsewhere);
    const file = join(root, ".story", "bus", "endpoints", `${endpoint.endpointId}.json`);
    renameSync(file, join(elsewhere, "endpoint.json"));
    symlinkSync(join(elsewhere, "endpoint.json"), file);
    probed.length = 0;
    const view = await readRosterWithBus(root, config, Date.now(), probe);
    expect(view.readUncertainty).toEqual([{ source: "bus-endpoint", cause: `${endpoint.endpointId}.json: not a regular file` }]);
    expect(view.seats.some((s) => s.clientTaskId === "linked-task")).toBe(false);
    expect(probed).toEqual([]);
    expect(view.diagnostics).toEqual(clean.diagnostics);
  });

  it("V4: roster list prints none of the new field: the JSON key set is exactly the existing one and Markdown does not mention it", async () => {
    const { root } = await project("printer");
    upsertSeat(root, seatStart("task-a"), iso(T0));
    writeFileSync(join(root, ".story", "telemetry", "roster", `${"0".repeat(64)}.json`), "{ not json");
    const { state } = await loadProject(root);
    const ctx = (format: "json" | "md") => ({ root, state, warnings: [], handoversDir: join(root, ".story", "handovers"), format }) as never;
    const json = JSON.parse((await handleRosterList(ctx("json"), {}, T0 + 1)).output).data;
    expect(Object.keys(json).sort()).toEqual(["busScanTruncated", "diagnostics", "includesTerminal", "live", "resultTruncated", "scanTruncated", "seats", "stale", "terminal"]);
    const md = (await handleRosterList(ctx("md"), {}, T0 + 1)).output;
    const view = await readRosterWithBus(root, state.config, T0 + 1);
    expect(view.readUncertainty?.map(u => u.source)).toEqual(["roster-entry"]);
    const { readUncertainty: _dropped, ...withoutField } = view;
    expect(md).toBe(rosterListMarkdown(withoutField, false, withoutField.seats.filter(s => s.state === "running")));
    expect(md).not.toMatch(/readUncertainty|roster-entry|uncertainty/i);
  });
});
