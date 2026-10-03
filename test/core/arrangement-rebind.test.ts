/**
 * ISS-1290: owner-authorized succession. `rebind` makes a successor with one
 * party replaced and closes the original with `continuedBy`; the checkpoint
 * travels, the nonce, receipts and coordination session never do, and the
 * new pen's first `start` seeds from the carried checkpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, chmod, rename, symlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { initProject } from "../../src/core/init.js";
import { writeArrangementUnlocked, loadArrangementsSafe } from "../../src/core/arrangement-loader.js";
import { coordinateDuet, readDuetCoordination, rebindArrangement } from "../../src/core/duet-coordination.js";
import { loadProject, writeConfig, writeTicketUnlocked, writeIssueUnlocked } from "../../src/core/project-loader.js";
import { upsertSeat, ROSTER_STALE_MS, ROSTER_RESULT_CAP } from "../../src/core/roster.js";
import type { LivenessProbe } from "../../src/core/roster-view.js";
import { initializeBus } from "../../src/bus/admin.js";
import { joinEndpoint } from "../../src/bus/endpoints.js";
import { formatArrangementRebindResult } from "../../src/core/output-formatter.js";
import type { DuetOperation } from "../../src/models/duet.js";

vi.setConfig({ testTimeout: 30_000 });

const id = "a-0123456789abcdef";
const pen = { client: "codex" as const, id: "pen-task" };
const worker = { client: "codex" as const, id: "worker-task" };
const newPen = { client: "codex" as const, id: "new-pen" };
const EVIDENCE = "Owner ruled the pen task gone at 02:00Z; succession to new-pen";
let root: string;
let session: string;
let revision: number;
let nonce: string;

async function call(op: Record<string, unknown>, arrangementId = id, caller = pen.id) {
  const result = await coordinateDuet(root, { id: arrangementId, clientTaskId: caller, expectedSessionId: session, expectedRevision: revision, ...op } as DuetOperation) as any;
  revision = result.state.revision;
  nonce = result.state.nonce;
  return result;
}
async function ready() {
  await call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "native-return" });
  return call({
    action: "receipt",
    receipt: { id: "hello", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() },
  });
}
const assignment = (n: number) => ({ id: `work-${n}`, scope: `Scope ${n}`, allowedActions: ["read"], acceptance: [`Acceptance ${n}`], nextGate: "pen review" });
const arrangementFile = (arrangementId = id) => join(root, ".story", "arrangements", `${arrangementId}.json`);
const runtimeFile = (arrangementId = id) => join(root, ".story", "duet-sessions", arrangementId, "state.json");
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf-8"));
const arrangementOf = (arrangementId: string) => loadArrangementsSafe(root).arrangements.find(a => a.id === arrangementId)!;

/**
 * One open assignment carrying obligations and a report, one resolved
 * (reduced in the checkpoint), and an archived id; then the runtime is
 * removed, as on the machine of a pen that is gone.
 */
async function coordinated(options: { dropRuntime?: boolean } = {}) {
  await ready();
  await call({ action: "assign", assignment: assignment(1) });
  await call({ action: "update", assignmentId: "work-1", event: { id: "ob-1", kind: "obligations", penOwes: ["ruling on F1"], workerOwes: ["mutant receipts"] } });
  await call({ action: "update", assignmentId: "work-1", event: { id: "rep-1", kind: "report", reportId: "report-1", content: "first report" } });
  await call({ action: "assign", assignment: assignment(2) });
  await call({ action: "update", assignmentId: "work-2", event: { id: "rep-2", kind: "report", reportId: "report-2" } });
  await call({ action: "update", assignmentId: "work-2", event: { id: "rev-2", kind: "review", reportId: "report-2" } });
  const arrangement = await readJson(arrangementFile());
  arrangement.coordinationCheckpoint.compactedAssignments = [{ id: "old-1", resolvedAt: "2026-09-01T00:00:00.000Z" }];
  await writeArrangementUnlocked(arrangement, root);
  if (options.dropRuntime !== false) await rm(join(root, ".story", "duet-sessions", id), { recursive: true, force: true });
  return arrangement;
}

/** Every tracked byte a rebind may touch, to prove a refusal wrote nothing. */
async function snapshot(): Promise<string> {
  const hash = createHash("sha256");
  for (const dir of ["arrangements", "tickets", "issues", "duet-sessions"]) {
    const base = join(root, ".story", dir);
    if (!existsSync(base)) continue;
    const walk = async (path: string): Promise<void> => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { hash.update(`d:${full}`); await walk(full); }
        else hash.update(`f:${full}:${readFileSync(full, "utf-8")}`);
      }
    };
    await walk(base);
  }
  return hash.digest("hex");
}
async function refusesWithoutWrites(run: () => Promise<unknown>, message: RegExp) {
  const before = await snapshot();
  await expect(run()).rejects.toThrow(message);
  expect(await snapshot()).toBe(before);
}
function rebind(over: Record<string, unknown> = {}, probe?: LivenessProbe) {
  return rebindArrangement(root, id, { role: "pen", to: newPen.id, evidence: EVIDENCE, clientTaskId: newPen.id, ...over } as any, Date.now(), probe) as Promise<any>;
}
const seat = (clientTaskId: string, client: "claude" | "codex" = "codex") =>
  ({ kind: "start" as const, client, clientTaskId, agentId: null, sessionId: `${clientTaskId}-session`, description: null });
async function enableBus() {
  const { state } = await loadProject(root);
  await writeConfig({ ...state.config, features: { ...state.config.features, bus: true } }, root);
  await initializeBus(root);
}

beforeEach(async () => {
  vi.stubEnv("STORYBLOQ_CLIENT", "codex");
  vi.stubEnv("CODEX_THREAD_ID", "");
  root = await mkdtemp(join(tmpdir(), "arrangement-rebind-"));
  await initProject(root, { name: "rebind" });
  await writeArrangementUnlocked({
    id,
    lifecycle: "active",
    bounds: ["ISS-1290"],
    parties: [
      { role: "pen", client: pen.client, identityAnchor: pen.id, modelTier: "top" },
      { role: "worker", client: worker.client, identityAnchor: worker.id },
    ],
    gates: [{ name: "plan-review", ackRole: "pen" }],
    unreachability: { onIrreversibleWork: "hold", onReversibleWork: "proceed" },
    createdDate: "2026-09-10",
    updatedAt: "2026-09-10T00:00:00.000Z",
  } as any, root);
  session = randomUUID();
  revision = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await chmod(join(root, ".story", "telemetry"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("rebind: succession by a successor arrangement", () => {
  it("R1: with no live pen seat, a new task with evidence rebinds the pen; same bounds, gates and unreachability; predecessor continued", async () => {
    const before = await coordinated();
    const result = await rebind();
    const successor = await readJson(arrangementFile(result.successorId));
    const predecessor = await readJson(arrangementFile());
    expect(successor.parties).toEqual([
      { role: "pen", client: "codex", identityAnchor: "new-pen" },
      { role: "worker", client: worker.client, identityAnchor: worker.id },
    ]);
    expect(successor.bounds).toEqual(before.bounds);
    expect(successor.gates).toEqual(before.gates);
    expect(successor.unreachability).toEqual(before.unreachability);
    expect(successor.lifecycle).toBe("active");
    expect(predecessor.lifecycle).toBe("closed");
    expect(predecessor.continuedBy).toBe(result.successorId);
    expect(successor.rebind).toMatchObject({
      role: "pen",
      from: { client: "codex", identityAnchor: pen.id },
      to: { client: "codex", identityAnchor: "new-pen" },
      evidence: EVIDENCE,
      recordedBy: { client: "codex", id: "new-pen" },
      penLiveness: "not-observed-locally",
    });
    expect(Number.isNaN(Date.parse(successor.rebind.at))).toBe(false);
  });

  it("R2: evidence is required (empty, whitespace) and bounded (4000 accepted, 4001 refused as invalid input), with no writes on refusal", async () => {
    await coordinated();
    await refusesWithoutWrites(() => rebind({ evidence: "" }), /evidence is required/);
    await refusesWithoutWrites(() => rebind({ evidence: "   " }), /evidence is required/);
    const before = await snapshot();
    const long = rebind({ evidence: "e".repeat(4001) });
    await expect(long).rejects.toMatchObject({ code: "invalid_input" });
    await expect(long).rejects.toThrow(/evidence exceeds 4000 characters/);
    expect(await snapshot()).toBe(before);
    const ok = await rebind({ evidence: "e".repeat(4000) });
    expect((await readJson(arrangementFile(ok.successorId))).rebind.evidence).toHaveLength(4000);
  });

  it("R3: a live pen seat refuses a non-pen caller; R3b: the same seat gone stale lets it through", async () => {
    await coordinated();
    const now = Date.now();
    expect(upsertSeat(root, seat(pen.id), new Date(now).toISOString()).ok).toBe(true);
    await refusesWithoutWrites(() => rebind(), /live seat/);
    await rm(join(root, ".story", "telemetry", "roster"), { recursive: true, force: true });
    expect(upsertSeat(root, seat(pen.id), new Date(now - ROSTER_STALE_MS - 60_000).toISOString()).ok).toBe(true);
    const result = await rebind();
    expect(result.penLiveness).toBe("not-observed-locally");
  });

  it("R4: the current pen may rebind while its own seat is live", async () => {
    await coordinated();
    upsertSeat(root, seat(pen.id), new Date().toISOString());
    const result = await rebind({ clientTaskId: pen.id });
    expect(result.penLiveness).toBe("live");
    expect((await readJson(arrangementFile(result.successorId))).rebind.recordedBy).toEqual({ client: "codex", id: pen.id });
  });
});

describe("rebind: an inconclusive roster read refuses a non-pen caller", () => {
  it("R4b: a live pen seat cut by the result cap is not absence", async () => {
    await coordinated();
    const now = Date.now();
    upsertSeat(root, seat(pen.id), new Date(now - 60_000).toISOString());
    for (let n = 0; n < ROSTER_RESULT_CAP + 1; n++) upsertSeat(root, seat(`other-${n}`), new Date(now - 1000 + n).toISOString());
    await refusesWithoutWrites(() => rebind(), /result cap|resultTruncated|truncat/i);
  });

  it("R4c: an unreadable roster entry refuses a non-pen caller; R4d: the pen proceeds as inconclusive", async () => {
    await coordinated();
    upsertSeat(root, seat("someone-else"), new Date().toISOString());
    await writeFile(join(root, ".story", "telemetry", "roster", `${"0".repeat(64)}.json`), "{ not json");
    await refusesWithoutWrites(() => rebind(), /roster-entry/);
    const result = await rebind({ clientTaskId: pen.id });
    expect(result.penLiveness).toBe("inconclusive");
    expect(result.livenessCause).toMatch(/roster-entry/);
  });

  it.skipIf(process.getuid?.() === 0)("R4e: a roster directory that cannot be inspected (EACCES) refuses a non-pen caller", async () => {
    await coordinated();
    upsertSeat(root, seat("someone-else"), new Date().toISOString());
    await chmod(join(root, ".story", "telemetry"), 0o000);
    await refusesWithoutWrites(() => rebind(), /roster-directory.*EACCES/);
  });

  it("R4e2: a symlinked roster directory is unsafe, not absent", async () => {
    await coordinated();
    const elsewhere = await mkdtemp(join(tmpdir(), "rebind-roster-elsewhere-"));
    try {
      await mkdir(join(root, ".story", "telemetry"), { recursive: true });
      await symlink(elsewhere, join(root, ".story", "telemetry", "roster"));
      await refusesWithoutWrites(() => rebind(), /roster-directory.*not a real directory/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("R4f: a pen Bus endpoint whose probe throws, or reads unknown, refuses a non-pen caller", async () => {
    await coordinated();
    await enableBus();
    await joinEndpoint(root, { client: "codex", clientTaskId: pen.id, surface: "codex_cli" });
    await refusesWithoutWrites(() => rebind({}, async () => { throw new Error("probe failed"); }), /bus-probe/);
    await refusesWithoutWrites(() => rebind({}, async () => "unknown"), /bus-probe/);
  });

  it("R4g: an unknown probe on an unrelated identity does not block", async () => {
    await coordinated();
    await enableBus();
    await joinEndpoint(root, { client: "codex", clientTaskId: "unrelated-task", surface: "codex_cli" });
    const result = await rebind({}, async () => "unknown");
    expect(result.penLiveness).toBe("not-observed-locally");
  });

  it("R4i: an endpoint-named symlink is recorded and refuses a non-pen caller; the probe never sees it", async () => {
    await coordinated();
    await enableBus();
    const endpoint = (await joinEndpoint(root, { client: "codex", clientTaskId: pen.id, surface: "codex_cli" })).endpoint;
    const elsewhere = await mkdtemp(join(tmpdir(), "rebind-endpoint-elsewhere-"));
    try {
      const file = join(root, ".story", "bus", "endpoints", `${endpoint.endpointId}.json`);
      await rename(file, join(elsewhere, "endpoint.json"));
      await symlink(join(elsewhere, "endpoint.json"), file);
      const probed: string[] = [];
      await refusesWithoutWrites(() => rebind({}, async (e) => { probed.push(e.endpointId); return "attached"; }), /bus-endpoint/);
      expect(probed).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("R4h: a roster directory that genuinely does not exist is not uncertainty", async () => {
    await coordinated();
    expect(existsSync(join(root, ".story", "telemetry", "roster"))).toBe(false);
    const result = await rebind();
    expect(result.penLiveness).toBe("not-observed-locally");
  });
});

describe("rebind: what travels and what never does", () => {
  it("R5: the checkpoint travels whole (open and resolved work, obligations, report ids, archive) with the new pair", async () => {
    const before = await coordinated();
    const result = await rebind();
    const checkpoint = (await readJson(arrangementFile(result.successorId))).coordinationCheckpoint;
    expect(checkpoint.assignments).toEqual(before.coordinationCheckpoint.assignments);
    expect(checkpoint.compactedAssignments).toEqual([{ id: "old-1", resolvedAt: "2026-09-01T00:00:00.000Z" }]);
    expect(checkpoint.revision).toBe(before.coordinationCheckpoint.revision);
    expect(checkpoint.pen).toEqual(newPen);
    expect(checkpoint.worker).toEqual(worker);
    const open = checkpoint.assignments.find((a: any) => a.input?.id === "work-1");
    expect(open.events.map((e: any) => e.input.reportId ?? e.input.kind)).toEqual(["obligations", "report-1"]);
    expect(open.events[0].input.workerOwes).toEqual(["mutant receipts"]);
    expect(result.carriedAssignments).toEqual(["work-1"]);
    expect(result.archivedAssignments.sort()).toEqual(["old-1", "work-2"]);
  });

  it("R6: never copied: coordination session, receipts, runtime (so no nonce); the successor's route is missing", async () => {
    await coordinated();
    const result = await rebind();
    const successor = await readJson(arrangementFile(result.successorId));
    expect(successor.currentCoordinationSessionId).toBeUndefined();
    expect(successor.communicationReceipts).toBeUndefined();
    expect(existsSync(runtimeFile(result.successorId))).toBe(false);
    expect(readDuetCoordination(root, arrangementOf(result.successorId)).route.status).toBe("missing");
  });
});

describe("rebind: the new pen's start seeds from the carried checkpoint", () => {
  async function successorStart(successorId: string, expectedRevision: number, newSessionId = randomUUID()) {
    return coordinateDuet(root, { id: successorId, clientTaskId: newPen.id, action: "start", expectedSessionId: null, expectedRevision, newSessionId, mode: "native-return" } as DuetOperation) as Promise<any>;
  }

  it("R7: seeded start carries the assignments at checkpoint revision + 1 with a fresh nonce; carried and archived ids stay refused", async () => {
    const before = await coordinated({ dropRuntime: false });
    const oldNonce = (await readJson(runtimeFile())).nonce;
    await rm(join(root, ".story", "duet-sessions", id), { recursive: true, force: true });
    const result = await rebind();
    const cp = before.coordinationCheckpoint;
    const s2 = randomUUID();
    const started = await successorStart(result.successorId, cp.revision, s2);
    expect(started.state.revision).toBe(cp.revision + 1);
    expect(started.state.assignments).toEqual(cp.assignments);
    expect(started.state.nonce).not.toBe(oldNonce);
    session = s2;
    revision = started.state.revision;
    nonce = started.state.nonce;
    await call({
      action: "receipt",
      receipt: { id: "hello-2", nonce, direction: "worker-to-manager", source: worker, destination: newPen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() },
    }, result.successorId, newPen.id);
    await expect(call({ action: "assign", assignment: { ...assignment(1), scope: "different" } }, result.successorId, newPen.id)).rejects.toThrow(/different immutable scope/);
    const replay = await call({ action: "assign", assignment: assignment(1) }, result.successorId, newPen.id);
    expect(replay.state.assignments.filter((a: any) => a.input?.id === "work-1")).toHaveLength(1);
    await expect(call({ action: "assign", assignment: { ...assignment(9), id: "old-1" } }, result.successorId, newPen.id)).rejects.toThrow(/compacted resolved history/);
    const fresh = await call({ action: "assign", assignment: assignment(3) }, result.successorId, newPen.id);
    expect(fresh.state.assignments.map((a: any) => a.input?.id ?? a.id)).toContain("work-3");
  });

  it("R7a: a seeded start at a stale revision refuses and writes nothing", async () => {
    const before = await coordinated();
    const result = await rebind();
    const cp = before.coordinationCheckpoint;
    const bytes = await readFile(arrangementFile(result.successorId), "utf-8");
    for (const stale of [cp.revision - 1, 0]) {
      await expect(successorStart(result.successorId, stale)).rejects.toThrow(/Stale duet revision/);
      expect(await readFile(arrangementFile(result.successorId), "utf-8")).toBe(bytes);
      expect(existsSync(runtimeFile(result.successorId))).toBe(false);
    }
  });

  it("R7r: an exact start retry returns the same revision and nonce and does not write", async () => {
    const before = await coordinated();
    const result = await rebind();
    const s2 = randomUUID();
    const first = await successorStart(result.successorId, before.coordinationCheckpoint.revision, s2);
    const bytes = await readFile(arrangementFile(result.successorId), "utf-8");
    const runtimeBytes = await readFile(runtimeFile(result.successorId), "utf-8");
    const again = await successorStart(result.successorId, before.coordinationCheckpoint.revision, s2);
    expect(again.state.revision).toBe(before.coordinationCheckpoint.revision + 1);
    expect(again.state.revision).toBe(first.state.revision);
    expect(again.state.nonce).toBe(first.state.nonce);
    expect(await readFile(arrangementFile(result.successorId), "utf-8")).toBe(bytes);
    expect(await readFile(runtimeFile(result.successorId), "utf-8")).toBe(runtimeBytes);
  });

  it("R7p: a later start preserves the runtime and returns current + 1; the seed is not re-entered", async () => {
    const before = await coordinated();
    const result = await rebind();
    const s2 = randomUUID();
    const started = await successorStart(result.successorId, before.coordinationCheckpoint.revision, s2);
    session = s2;
    revision = started.state.revision;
    nonce = started.state.nonce;
    await call({
      action: "receipt",
      receipt: { id: "hello-2", nonce, direction: "worker-to-manager", source: worker, destination: newPen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() },
    }, result.successorId, newPen.id);
    await call({ action: "assign", assignment: assignment(3) }, result.successorId, newPen.id);
    // A harness cursor is runtime-only state: the checkpoint projection strips
    // it, so a start that reloaded the checkpoint would lose it.
    const cursored = await call({ action: "update", assignmentId: "work-3", event: { id: "cursor-3", kind: "cursor", cursor: "runtime-only-cursor" } }, result.successorId, newPen.id);
    const work3 = (assignments: any[]) => assignments.find((a: any) => (a.input?.id ?? a.id) === "work-3");
    expect(work3((await readJson(runtimeFile(result.successorId))).assignments).cursor).toBe("runtime-only-cursor");
    const checkpointWork3 = work3((await readJson(arrangementFile(result.successorId))).coordinationCheckpoint.assignments);
    expect(checkpointWork3).toBeDefined();
    expect(checkpointWork3.cursor).toBeUndefined();
    expect(checkpointWork3.events.some((e: any) => e.input.kind === "cursor")).toBe(false);
    const s3 = randomUUID();
    const later = await call({ action: "start", expectedSessionId: s2, newSessionId: s3, mode: "native-return" }, result.successorId, newPen.id);
    expect(later.state.revision).toBe(cursored.state.revision + 1);
    expect(later.state.assignments).toEqual(cursored.state.assignments);
    expect(work3(later.state.assignments).cursor).toBe("runtime-only-cursor");
  });

  it("R7b (compatibility, green on base once the import resolves): a non-rebind arrangement never seeds", async () => {
    // Two independent fixtures: the same non-rebind arrangement with a
    // non-empty checkpoint at revision 5, no runtime and no session.
    const checkpoint = {
      revision: 5,
      sessionId: randomUUID(),
      pen,
      worker,
      assignments: [
        { input: { ...assignment(1), penOwes: [], workerOwes: [], resourceHolds: [], pendingDecision: "" }, dispatchSessionId: randomUUID(), assignee: worker, status: "assigned", createdAt: "2026-09-10T00:00:00.000Z", lastWorkerActivityAt: "2026-09-10T00:00:00.000Z", events: [] },
        { input: { ...assignment(2), penOwes: [], workerOwes: [], resourceHolds: [], pendingDecision: "" }, dispatchSessionId: randomUUID(), assignee: worker, status: "assigned", createdAt: "2026-09-10T00:00:00.000Z", lastWorkerActivityAt: "2026-09-10T00:00:00.000Z", events: [] },
      ],
    };
    const fixture = async () => {
      await writeArrangementUnlocked({ ...arrangementOf(id), coordinationCheckpoint: checkpoint } as any, root);
    };
    await fixture();
    const ok = await call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "native-return" });
    expect(ok.state.revision).toBe(1);
    expect(ok.state.assignments).toEqual([]);

    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "arrangement-rebind-"));
    await initProject(root, { name: "rebind" });
    await writeArrangementUnlocked({
      id, lifecycle: "active", bounds: ["ISS-1290"],
      parties: [{ role: "pen", client: pen.client, identityAnchor: pen.id }, { role: "worker", client: worker.client, identityAnchor: worker.id }],
      gates: [], unreachability: { onIrreversibleWork: "hold" }, createdDate: "2026-09-10", updatedAt: "2026-09-10T00:00:00.000Z",
    } as any, root);
    await fixture();
    session = randomUUID();
    revision = 5;
    const before = await snapshot();
    await expect(call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "native-return" })).rejects.toThrow(/Stale duet revision/);
    expect(await snapshot()).toBe(before);
  });
});

describe("rebind: refusals and side effects", () => {
  it("R8: continued, closed, conflicted, node-qualified, already bound, the other party, no actor: all refused with no writes", async () => {
    await coordinated();
    await refusesWithoutWrites(() => rebind({ to: pen.id }), /already bound/);
    await refusesWithoutWrites(() => rebind({ to: worker.id }), /other party|worker/);
    vi.stubEnv("CODEX_THREAD_ID", "");
    await refusesWithoutWrites(() => rebind({ clientTaskId: undefined }), /resolved client task id/);

    const base = arrangementOf(id) as any;
    await writeArrangementUnlocked({ ...base, bounds: ["other-node:ISS-1"] }, root);
    await refusesWithoutWrites(() => rebind(), /node-qualified bounds; rotation cannot carry federated earmarks/);
    await writeArrangementUnlocked({ ...base, _conflicts: [{ fieldPath: "lifecycle", kind: "field", base: "active", ours: "active", theirs: "closed" }] }, root);
    await refusesWithoutWrites(() => rebind(), /conflict/);
    await writeArrangementUnlocked({ ...base, lifecycle: "closed" }, root);
    await refusesWithoutWrites(() => rebind(), /closed/);
    await writeArrangementUnlocked(base, root);

    const first = await rebind();
    await refusesWithoutWrites(() => rebind(), new RegExp(`continued by ${first.successorId}`));
  });

  it("R8b: a suspended arrangement may be rebound and the successor stays suspended", async () => {
    await coordinated();
    await writeArrangementUnlocked({ ...(arrangementOf(id) as any), lifecycle: "suspended" }, root);
    const result = await rebind();
    expect((await readJson(arrangementFile(result.successorId))).lifecycle).toBe("suspended");
  });

  it("R9: worker rebind replaces the worker; unresolved assignees move, resolved and compacted history stays", async () => {
    await coordinated();
    const result = await rebind({ role: "worker", to: "new-worker", clientTaskId: pen.id });
    const successor = await readJson(arrangementFile(result.successorId));
    expect(successor.parties.find((p: any) => p.role === "worker")).toEqual({ role: "worker", client: "codex", identityAnchor: "new-worker" });
    expect(successor.parties.find((p: any) => p.role === "pen")).toMatchObject({ identityAnchor: pen.id, modelTier: "top" });
    const byId = (x: string) => successor.coordinationCheckpoint.assignments.find((a: any) => (a.input?.id ?? a.id) === x);
    expect(byId("work-1").assignee).toEqual({ client: "codex", id: "new-worker" });
    expect(byId("work-2").assignee).toEqual(worker);
    expect(successor.coordinationCheckpoint.worker).toEqual({ client: "codex", id: "new-worker" });
  });

  it("R10: earmarks on a bound ticket and issue are re-pointed to the successor", async () => {
    await coordinated();
    const earmark = { reservedBy: pen, arrangementId: id, since: new Date().toISOString(), stage: "reserved", holderRole: "worker", holderSession: null };
    await writeTicketUnlocked({ id: "T-001", title: "Carried", description: "", type: "feature", status: "open", phase: null, order: 1, createdDate: "2026-09-10", completedDate: null, blockedBy: [], earmark } as any, root);
    await writeIssueUnlocked({ id: "ISS-001", title: "Carried issue", status: "open", severity: "low", components: [], impact: "", resolution: null, location: [], discoveredDate: "2026-09-10", resolvedDate: null, relatedTickets: [], updatedAt: "2026-09-10T00:00:00.000Z", earmark } as any, root);
    const result = await rebind();
    const { state } = await loadProject(root);
    expect(state.tickets.find(t => t.id === "T-001")!.earmark!.arrangementId).toBe(result.successorId);
    expect(state.issues.find(i => i.id === "ISS-001")!.earmark!.arrangementId).toBe(result.successorId);
    expect(result.carriedEarmarks.sort()).toEqual(["ISS-001", "T-001"]);
  });

  it("R11: a readable local runtime that diverges from the checkpoint refuses", async () => {
    await coordinated({ dropRuntime: false });
    const arrangement = await readJson(arrangementFile());
    arrangement.coordinationCheckpoint.revision += 1;
    await writeArrangementUnlocked(arrangement, root);
    await refusesWithoutWrites(() => rebind(), /diverges from the checkpoint/);
  });

  it("R12: the result and both formats carry the machine-local caveat, the carried ids and no coordination session", async () => {
    await coordinated();
    const result = await rebind();
    expect(result.livenessCause).toBeNull();
    const md = formatArrangementRebindResult(result, "md");
    expect(md).toContain("Rebound pen of");
    expect(md).toContain("Liveness is machine-local: a pen on another machine reads as not live");
    expect(md).toContain("No coordination session was copied");
    const json = JSON.parse(formatArrangementRebindResult(result, "json")).data;
    expect(json.coordinationSession).toBeNull();
    expect(json.next).toBe("start");
    expect(json.liveness.scope).toBe("machine-local");
    expect(json.carriedAssignments).toEqual(["work-1"]);
    expect(json.archivedAssignments.sort()).toEqual(["old-1", "work-2"]);
    expect(json.successor).toBe(result.successorId);
  });

  it("R12b: Markdown sanitizes evidence and the liveness cause; no control sequence or forged line reaches the output", async () => {
    await coordinated();
    const forged = "ok\u001b[31mred\rPen liveness: live\nPen liveness: live";
    const result = await rebind({ evidence: forged });
    const md = formatArrangementRebindResult({ ...result, penLiveness: "inconclusive", livenessCause: "roster\u001b]0;title\u0007\r\nPen liveness: live" }, "md");
    expect(md).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    const lines = md.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.filter(line => line.startsWith("Pen liveness:"))).toHaveLength(1);
    expect(lines[2]).toMatch(/^Pen liveness: inconclusive \(/);
    expect(lines[1]).toContain("evidence: ok?[31mred?Pen liveness: live?Pen liveness: live.");
    // The stored audit keeps the original evidence; only the display is sanitized.
    expect(result.evidence).toBe(forged);
    expect((await readJson(arrangementFile(result.successorId))).rebind.evidence).toBe(forged);
  });
});

