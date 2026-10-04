import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initProject } from "../../src/core/init.js";
import { writeArrangementUnlocked, loadArrangementsSafe, ARRANGEMENT_MAX_BYTES } from "../../src/core/arrangement-loader.js";
import { coordinateDuet, readDuetCoordination, compactArrangementCheckpoint, rotateArrangement } from "../../src/core/duet-coordination.js";
import { loadProject, withProjectLock, writeIssueUnlocked, writeTicketUnlocked } from "../../src/core/project-loader.js";
import { handleDuetGet } from "../../src/cli/commands/duet.js";
import { handleEarmarkGet } from "../../src/cli/commands/earmark.js";
import { handleArrangementUpdate } from "../../src/cli/commands/arrangement.js";
import type { CommandContext } from "../../src/cli/types.js";
import type { DuetOperation } from "../../src/models/duet.js";

// Each scenario replays dozens of real locked coordination writes against a
// temp project, so the default 5s budget is too tight on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

/**
 * A barrier fired from INSIDE the rotation's locked critical section, after
 * its snapshots are read and before its transaction commits. `hoisted` is
 * required: the mock factory below runs before this module's body does.
 */
const hooks = vi.hoisted(() => ({ beforeItemWrite: null as null | (() => Promise<void>) }));
vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    prepareTicketWrite: async (...args: Parameters<typeof actual.prepareTicketWrite>) => {
      const hook = hooks.beforeItemWrite;
      hooks.beforeItemWrite = null;
      if (hook) await hook();
      return actual.prepareTicketWrite(...args);
    },
  };
});

const id = "a-0123456789abcdef";
const pen = { client: "codex" as const, id: "pen-task" };
const worker = { client: "codex" as const, id: "worker-task" };
let root: string;
let session: string;
let revision: number;
let nonce: string;

async function call(op: Record<string, unknown>) {
  const result = await coordinateDuet(root, { id, clientTaskId: pen.id, expectedSessionId: session, expectedRevision: revision, ...op } as DuetOperation) as any;
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
/** The measured shape from the issue: a 1.6 KB input and 1.4 KB events. */
function bigAssignment(n: number) {
  return {
    id: `work-${n}`,
    scope: `Scope ${n} `.padEnd(1200, "s"),
    allowedActions: ["read", "write"],
    acceptance: [`Acceptance ${n} `.padEnd(400, "a")],
    nextGate: "pen review",
  };
}
function bigEvent(assignmentNumber: number, suffix: string, extra: Record<string, unknown> = {}) {
  return { id: `event-${assignmentNumber}-${suffix}`, content: `Event ${suffix} `.padEnd(1400, "e"), ...extra };
}
function arrangementPath(arrangementId: string = id): string {
  return join(root, ".story", "arrangements", `${arrangementId}.json`);
}
function runtimeFile(arrangementId: string = id): string {
  return join(root, ".story", "duet-sessions", arrangementId, "state.json");
}
function currentArrangement(arrangementId: string = id) {
  return loadArrangementsSafe(root).arrangements.find(a => a.id === arrangementId)!;
}
/** Dispatch `count` assignments and resolve every one of them. */
async function resolveAssignments(count: number) {
  await ready();
  for (let n = 1; n <= count; n++) {
    const assignment = bigAssignment(n);
    await call({ action: "assign", assignment });
    await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "report"), kind: "report", reportId: `report-${n}` } });
    await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "review"), kind: "review", reportId: `report-${n}` } });
  }
}
/**
 * Fill an unrelated, non-checkpoint field until the FILE is `targetBytes`,
 * so capacity pressure is real and comes from outside the checkpoint.
 */
async function padArrangement(targetBytes: number) {
  // Create the wrapper first, so the structural bytes it adds are already
  // counted before any delta is computed against the file size.
  if ((currentArrangement() as any).treeProtocol === undefined) {
    await writeArrangementUnlocked({ ...(currentArrangement() as any), treeProtocol: { pathScopes: ["x"] } } as any, root);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const arrangement = currentArrangement() as any;
    const currentPad = (arrangement.treeProtocol?.pathScopes?.[0] ?? "").length;
    const delta = targetBytes - (await arrangementBytes());
    const nextPad = Math.max(0, currentPad + delta);
    if (nextPad === currentPad) return;
    await writeArrangementUnlocked({ ...arrangement, treeProtocol: { pathScopes: ["x".repeat(nextPad)] } } as any, root);
    if (Math.abs(targetBytes - (await arrangementBytes())) <= 2) return;
  }
}
/** A ticket earmarked against this arrangement, for the carry-forward. */
async function earmarkedTicket(): Promise<string> {
  const ticketId = "T-001";
  await writeTicketUnlocked({
    id: ticketId,
    title: "Carried work",
    description: "Earmarked against the arrangement under test",
    type: "feature",
    status: "open",
    phase: null,
    order: 1,
    createdDate: "2026-09-10",
    completedDate: null,
    blockedBy: [],
    earmark: { reservedBy: pen, arrangementId: id, since: new Date().toISOString(), stage: "reserved", holderRole: "worker", holderSession: null },
  } as any, root);
  return ticketId;
}
async function ctxFor(format: "json" | "md"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}
/**
 * Reproduces a PRE-FIX arrangement: 12 assignments in the measured mix,
 * one receipt, and a raw (uncompacted) checkpoint, padded to exactly
 * `targetBytes`. Built by replaying real coordination writes and then
 * rewriting the checkpoint into its pre-ISS-1191 raw projection, so the
 * arrangement and its runtime are genuinely consistent with each other.
 */
async function buildPreFixArrangement(targetBytes: number) {
  await ready();
  for (let n = 1; n <= 12; n++) {
    const assignment = bigAssignment(n);
    await call({ action: "assign", assignment });
    if (n <= 9) await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "report"), kind: "report", reportId: `report-${n}` } });
    if (n <= 5) await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "review"), kind: "review", reportId: `report-${n}` } });
  }
  const runtime = JSON.parse(await readFile(runtimeFile(), "utf-8"));
  const rawCheckpoint = () => ({
    revision: runtime.revision, sessionId: runtime.start.sessionId, pen: runtime.pen, worker: runtime.worker,
    assignments: runtime.assignments.map((a: any) => { const { cursor: _c, ...rest } = a; return rest; }),
  });
  // Pad one assignment's scope, inside the checkpoint AND the runtime, until
  // the file is exactly the measured size.
  for (let attempt = 0; attempt < 6; attempt++) {
    const arrangement = currentArrangement() as any;
    await writeArrangementUnlocked({ ...arrangement, coordinationCheckpoint: rawCheckpoint() } as any, root);
    await writeFile(runtimeFile(), JSON.stringify(runtime, null, 2), "utf-8");
    let delta = targetBytes - (await arrangementBytes());
    if (delta === 0) return;
    // `scope` is capped at 4000 characters, so the padding is spread across
    // assignments; the arrangement file carries each scope once.
    for (const assignment of runtime.assignments) {
      if (delta === 0) break;
      const current = assignment.input.scope.length;
      const change = delta > 0 ? Math.min(4000 - current, delta) : Math.max(1 - current, delta);
      if (change === 0) continue;
      assignment.input.scope = assignment.input.scope.slice(0, 1).padEnd(current + change, "p");
      delta -= change;
    }
  }
  throw new Error(`could not size the fixture to ${targetBytes} bytes`);
}
async function arrangementBytes(): Promise<number> {
  return (await stat(arrangementPath())).size;
}
function checkpointOf(arrangement: any) {
  return arrangement.coordinationCheckpoint;
}

beforeEach(async () => {
  vi.stubEnv("STORYBLOQ_CLIENT", "codex");
  root = await mkdtemp(join(tmpdir(), "arrangement-capacity-"));
  await initProject(root, { name: "capacity" });
  await writeArrangementUnlocked({
    id,
    lifecycle: "active",
    bounds: ["ISS-1191"],
    parties: [
      { role: "pen", client: pen.client, identityAnchor: pen.id },
      { role: "worker", client: worker.client, identityAnchor: worker.id },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-09-10",
    updatedAt: "2026-09-10T00:00:00.000Z",
  }, root);
  session = randomUUID();
  revision = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/**
 * ISS-1191's first ACCEPTANCE item: 14 assignments at the measured sizes
 * used to hit the 64 KiB wall after roughly 12 to 14 assignments. With
 * checkpoint compaction the arrangement stays under the cap, open
 * assignments stay byte-identical to the runtime, and each resolved
 * assignment keeps its LAST event only.
 */
describe("checkpoint compaction under the arrangement cap", () => {
  it("keeps 14 measured-size assignments under the cap and reduces resolved ones to their last event", async () => {
    await ready();
    for (let n = 1; n <= 14; n++) {
      const assignment = bigAssignment(n);
      await call({ action: "assign", assignment });
      await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "progress"), kind: "progress" } });
      await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "report"), kind: "report", reportId: `report-${n}` } });
      // The last four stay open: assigned/needs-review must survive intact.
      if (n <= 10) {
        await call({ action: "update", assignmentId: assignment.id, event: { ...bigEvent(n, "review"), kind: "review", reportId: `report-${n}` } });
      }
    }

    expect(await arrangementBytes()).toBeLessThanOrEqual(ARRANGEMENT_MAX_BYTES);

    const view = readDuetCoordination(root, loadArrangementsSafe(root).arrangements.find(a => a.id === id)!);
    expect(view.route.status).toBe("current");
    const checkpoint = checkpointOf(view.arrangement)!;
    expect(checkpoint.revision).toBe(view.state!.revision);

    // Open assignments: byte-identical to the runtime.
    const openRuntime = view.state!.assignments.filter((a: any) => a.input && a.status !== "resolved");
    expect(openRuntime).toHaveLength(4);
    for (const runtimeAssignment of openRuntime) {
      const stored = checkpoint.assignments.find((a: any) => (a.input ? a.input.id : a.id) === runtimeAssignment.input.id);
      expect(stored).toEqual(runtimeAssignment);
    }

    // Resolved assignments: reduced, last event only, nothing invented.
    const reduced = checkpoint.assignments.filter((a: any) => a.compacted === true);
    const archived = checkpoint.compactedAssignments ?? [];
    expect(reduced.length + archived.length).toBe(10);
    for (const entry of reduced) {
      expect(entry.status).toBe("resolved");
      expect(entry.events).toHaveLength(1);
      expect(Object.keys(entry).sort()).toEqual(
        ["assignee", "compacted", "createdAt", "dispatchSessionId", "events", "id", "lastWorkerActivityAt", "status"],
      );
      // The retained event is the runtime's own last event, byte for byte:
      // an implementation that rewrote its content or evidence, or kept a
      // different event, fails here.
      const runtimeAssignment = view.state!.assignments.find((a: any) => (a.input?.id ?? a.id) === entry.id);
      const runtimeEvents = runtimeAssignment.events.filter((e: any) => e.input.kind !== "cursor");
      expect(entry.events[0]).toEqual(runtimeEvents[runtimeEvents.length - 1]);
      expect(entry.events[0].input.kind).toBe("review");
    }
  });

  it("refuses a write held at the pre-compaction revision", async () => {
    await ready();
    const assignment = bigAssignment(1);
    await call({ action: "assign", assignment });
    const stale = revision - 1;
    await expect(coordinateDuet(root, {
      id, clientTaskId: pen.id, expectedSessionId: session, expectedRevision: stale,
      action: "update", assignmentId: assignment.id, event: { id: "late", kind: "progress", content: "hello" },
    } as DuetOperation)).rejects.toThrow(/revision/i);
  });

  it("archives the oldest resolved assignments only when reduction is not enough", async () => {
    await resolveAssignments(8);
    // Reduction alone holds until something else fills the file; pad an
    // unrelated field so the projection crosses the 80% threshold.
    await padArrangement(60_000);
    const assignment = bigAssignment(99);
    await call({ action: "assign", assignment });

    const checkpoint = checkpointOf(currentArrangement())!;
    const archived = checkpoint.compactedAssignments ?? [];
    expect(archived.length).toBeGreaterThan(0);
    // The oldest go first, the newest five reduced records stay.
    expect(archived.map((a: any) => a.id)).toEqual(["work-1", "work-2", "work-3"]);
    expect(checkpoint.assignments.filter((a: any) => a.compacted === true)).toHaveLength(5);
    // Moved, never deleted: the tracked checkpoint no longer carries the
    // record, the runtime still holds every byte of it.
    expect(checkpoint.assignments.some((a: any) => (a.input?.id ?? a.id) === "work-1")).toBe(false);
    const runtimeWork1 = readDuetCoordination(root, currentArrangement()).state!.assignments.find((a: any) => (a.input?.id ?? a.id) === "work-1");
    expect(runtimeWork1).toBeDefined();
    // resolvedAt is retained evidence, not the clock: each tombstone
    // carries the recordedAt of that assignment's own review event, which
    // was written strictly before the compaction that archived it.
    const runtime = readDuetCoordination(root, currentArrangement()).state!;
    for (const entry of archived) {
      const source = runtime.assignments.find((a: any) => (a.input?.id ?? a.id) === entry.id)!;
      const review = [...source.events].reverse().find((e: any) => e.input.kind === "review")!;
      expect(entry.resolvedAt).toBe(review.recordedAt);
      expect(Date.parse(entry.resolvedAt)).toBeLessThan(Date.parse(currentArrangement().updatedAt));
    }
  });

  it("keeps the projection a fixed point across reload, repeated compaction, a size change and recovery", async () => {
    await resolveAssignments(8);
    await padArrangement(60_000);
    await call({ action: "assign", assignment: bigAssignment(99) });
    const archivedBefore = checkpointOf(currentArrangement())!.compactedAssignments;
    expect(archivedBefore.length).toBeGreaterThan(0);

    // Reload: still healthy.
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("current");
    // Repeated compaction is a no-op that writes nothing.
    const beforeBytes = await arrangementBytes();
    const noop = await compactArrangementCheckpoint(root, id, pen.id);
    expect(noop.changed).toBe(false);
    expect(await arrangementBytes()).toBe(beforeBytes);
    // A size change elsewhere in the file must not flip the route: the
    // projection route equality uses is size-independent.
    await padArrangement(60_500);
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("current");

    // Recovery: consistency is restored first, and only a FRESH receipt for
    // the new session and nonce makes the route current again.
    const beforeRecovery = checkpointOf(currentArrangement())!;
    await unlink(runtimeFile());
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("recovery-required");
    const priorSession = session;
    session = randomUUID();
    const recovered = await coordinateDuet(root, {
      id, clientTaskId: pen.id, expectedSessionId: priorSession, expectedRevision: beforeRecovery.revision,
      action: "recover", newSessionId: session, mode: "native-return", recoveryEvidence: "runtime lost in test",
    } as DuetOperation) as any;
    revision = recovered.state.revision;
    nonce = recovered.state.nonce;
    expect(recovered.route.status).not.toBe("recovery-required");
    // The archive survives recovery, which drops those assignments from the
    // runtime entirely.
    expect(checkpointOf(recovered.arrangement)!.compactedAssignments).toEqual(archivedBefore);
    const ready = await call({
      action: "receipt",
      receipt: { id: "hello-2", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() },
    });
    expect(ready.route.status).toBe("current");
  });

  it("refuses every write when an archived id reappears as open runtime work", async () => {
    await resolveAssignments(8);
    await padArrangement(60_000);
    await call({ action: "assign", assignment: bigAssignment(99) });
    const archivedId = checkpointOf(currentArrangement())!.compactedAssignments[0].id;

    // Hand-edit the runtime so an archived id is live again: the archive
    // says resolved history, the runtime says open work. That is divergence,
    // never something to silently drop.
    const state = JSON.parse(await readFile(runtimeFile(), "utf-8"));
    const revived = state.assignments.find((a: any) => (a.input?.id ?? a.id) === archivedId);
    expect(revived).toBeDefined();
    revived.status = "needs-review";
    await writeFile(runtimeFile(), JSON.stringify(state, null, 2), "utf-8");

    const arrangementSnapshot = await readFile(arrangementPath(), "utf-8");
    const runtimeSnapshot = await readFile(runtimeFile(), "utf-8");
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("recovery-required");
    await expect(call({ action: "assign", assignment: bigAssignment(100) })).rejects.toThrow(/recovery/i);
    await expect(compactArrangementCheckpoint(root, id, pen.id)).rejects.toThrow(/diverges|archived/i);
    await expect(rotateArrangement(root, id, pen.id)).rejects.toThrow(/route|verified/i);
    expect(await readFile(arrangementPath(), "utf-8")).toBe(arrangementSnapshot);
    expect(await readFile(runtimeFile(), "utf-8")).toBe(runtimeSnapshot);
  });

  it("refuses to reuse an archived assignment id for new work", async () => {
    await resolveAssignments(8);
    await padArrangement(60_000);
    await call({ action: "assign", assignment: bigAssignment(99) });
    const archivedId = checkpointOf(currentArrangement())!.compactedAssignments[0].id;
    await expect(call({ action: "assign", assignment: { ...bigAssignment(1), id: archivedId } })).rejects.toThrow(/compacted resolved history/);
    await expect(call({ action: "update", assignmentId: archivedId, event: { id: "reopen", kind: "progress", content: "x" } })).rejects.toThrow(/compacted resolved history/);
  });

  it("refuses compaction it cannot vouch for, and compacts a checkpoint whose runtime is gone", async () => {
    await resolveAssignments(3);
    const checkpointRevision = checkpointOf(currentArrangement())!.revision;

    // A non-pen caller is refused.
    await expect(compactArrangementCheckpoint(root, id, worker.id)).rejects.toThrow(/pen/);

    // An unreadable runtime is never treated as an absent one: the tracked
    // checkpoint is the only surviving copy of that history.
    const arrangementSnapshot = await readFile(arrangementPath(), "utf-8");
    const runtimeSnapshot = await readFile(runtimeFile(), "utf-8");
    await writeFile(runtimeFile(), "{ not json", "utf-8");
    await expect(compactArrangementCheckpoint(root, id, pen.id)).rejects.toThrow(/readable runtime/);
    expect(await readFile(arrangementPath(), "utf-8")).toBe(arrangementSnapshot);
    expect(await readFile(runtimeFile(), "utf-8")).toBe("{ not json");
    await writeFile(runtimeFile(), runtimeSnapshot, "utf-8");

    // Unresolved merge conflicts are refused before anything is written.
    const conflicted = { ...currentArrangement(), _conflicts: [{ fieldPath: "bounds", kind: "field" as const, base: [], ours: [], theirs: [] }] };
    await writeArrangementUnlocked(conflicted as any, root);
    await expect(compactArrangementCheckpoint(root, id, pen.id)).rejects.toThrow(/merge conflicts/);
    await writeArrangementUnlocked(currentArrangement() as any, root);

    // An absent runtime: the checkpoint is compacted in place and its own
    // CAS revision moves, so a pen holding the old one is refused.
    await unlink(runtimeFile());
    await writeArrangementUnlocked({ ...JSON.parse(arrangementSnapshot) } as any, root);
    const result = await compactArrangementCheckpoint(root, id, pen.id);
    expect(result.changed).toBe(false);
  });

  it("moves both revisions together when it compacts with the runtime present", async () => {
    await resolveAssignments(3);
    // Put the pair into the pre-ISS-1191 shape (raw checkpoint, matching
    // runtime) so an explicit compaction has real work to do while the
    // runtime is present and consistent.
    const runtime = JSON.parse(await readFile(runtimeFile(), "utf-8"));
    const raw = {
      revision: runtime.revision, sessionId: runtime.start.sessionId, pen: runtime.pen, worker: runtime.worker,
      assignments: runtime.assignments.map((a: any) => { const { cursor: _c, ...rest } = a; return rest; }),
    };
    await writeArrangementUnlocked({ ...(currentArrangement() as any), coordinationCheckpoint: raw } as any, root);
    const captured = runtime.revision;
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("current");

    const result = await compactArrangementCheckpoint(root, id, pen.id);
    expect(result.changed).toBe(true);

    // Both persisted revisions move, and they move together: a checkpoint
    // revision that diverged from the runtime's would break route equality.
    const afterCheckpoint = checkpointOf(currentArrangement())!;
    const afterRuntime = JSON.parse(await readFile(runtimeFile(), "utf-8"));
    expect(afterCheckpoint.revision).toBe(captured + 1);
    expect(afterRuntime.revision).toBe(captured + 1);
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("current");

    // And a pen still holding the pre-compaction revision is refused.
    await expect(coordinateDuet(root, {
      id, clientTaskId: pen.id, expectedSessionId: runtime.start.sessionId, expectedRevision: captured,
      action: "assign", assignment: bigAssignment(90),
    } as DuetOperation)).rejects.toThrow(/revision/i);
  });

  it("bumps the checkpoint revision when it compacts a runtime-less checkpoint", async () => {
    await resolveAssignments(3);
    // Rewrite the stored checkpoint into its pre-ISS-1191 raw form so there
    // is genuinely something to compact, then remove the runtime.
    const state = JSON.parse(await readFile(runtimeFile(), "utf-8"));
    const arrangement = currentArrangement() as any;
    const raw = {
      revision: state.revision, sessionId: state.start.sessionId, pen: state.pen, worker: state.worker,
      assignments: state.assignments.map((a: any) => { const { cursor: _c, ...rest } = a; return rest; }),
    };
    await writeArrangementUnlocked({ ...arrangement, coordinationCheckpoint: raw } as any, root);
    await unlink(runtimeFile());

    const before = checkpointOf(currentArrangement())!.revision;
    const result = await compactArrangementCheckpoint(root, id, pen.id);
    expect(result.changed).toBe(true);
    const after = checkpointOf(currentArrangement())!;
    expect(after.revision).toBe(before + 1);
    expect(after.assignments.every((a: any) => a.compacted === true)).toBe(true);
    expect(result.after.bytes).toBeLessThan(result.before.bytes);

    // Recovery held at the pre-compaction revision gets the CAS refusal.
    await expect(coordinateDuet(root, {
      id, clientTaskId: pen.id, expectedSessionId: state.start.sessionId, expectedRevision: before,
      action: "recover", newSessionId: randomUUID(), mode: "native-return", recoveryEvidence: "stale revision",
    } as DuetOperation)).rejects.toThrow(/revision|checkpoint/i);
  });

  it("T-486 B6: rotation re-points an earmarked issue with the write guard active", async () => {
    await resolveAssignments(2);
    await call({ action: "assign", assignment: bigAssignment(50) });
    const earmark = { reservedBy: pen, arrangementId: id, since: new Date().toISOString(), stage: "reserved", holderRole: "worker", holderSession: null };
    await withProjectLock(root, { strict: false }, () => writeIssueUnlocked({
      id: "ISS-001", title: "Carried issue", status: "open", severity: "low", components: [], impact: "", resolution: null,
      location: [], discoveredDate: "2026-09-10", resolvedDate: null, relatedTickets: [], earmark,
    } as any, root));
    const rotated = await rotateArrangement(root, id, pen.id);
    expect(rotated.carriedEarmarks).toEqual(["ISS-001"]);
    const { state } = await loadProject(root);
    expect(state.issues.find((i) => i.id === "ISS-001")!.earmark!.arrangementId).toBe(rotated.successorId);
  });

  it("rotates open work into a successor and makes the predecessor terminal", async () => {
    await resolveAssignments(2);
    const open = bigAssignment(50);
    await call({ action: "assign", assignment: open });
    const ticketId = await earmarkedTicket();

    const rotated = await rotateArrangement(root, id, pen.id);
    expect(rotated.alreadyRotated).toBe(false);
    expect(rotated.carriedAssignments).toEqual([open.id]);
    expect(rotated.carriedEarmarks).toEqual([ticketId]);

    // The successor is live, carries the verified session, and accepts work.
    const successorId = rotated.successorId;
    const successorView = readDuetCoordination(root, currentArrangement(successorId));
    expect(successorView.route.status).toBe("current");
    expect(successorView.state!.assignments.map((a: any) => a.input.id)).toEqual([open.id]);
    const assigned = await coordinateDuet(root, {
      id: successorId, clientTaskId: pen.id, expectedSessionId: session, expectedRevision: successorView.state!.revision,
      action: "assign", assignment: bigAssignment(51),
    } as DuetOperation) as any;
    expect(assigned.state.assignments).toHaveLength(2);
    // An update on a CARRIED assignment still works in the successor.
    const updated = await coordinateDuet(root, {
      id: successorId, clientTaskId: pen.id, expectedSessionId: session, expectedRevision: assigned.state.revision,
      action: "update", assignmentId: open.id, event: { id: "carried-progress", kind: "progress", content: "still going" },
    } as DuetOperation) as any;
    expect(updated.state.assignments.find((a: any) => a.input.id === open.id).events).toHaveLength(1);

    // The earmark points at the successor now.
    const { state: projectAfter } = await loadProject(root);
    expect(projectAfter.tickets.find(t => t.id === ticketId)!.earmark!.arrangementId).toBe(successorId);

    // The predecessor keeps its history, is closed, and is terminal.
    const predecessor = currentArrangement();
    expect(predecessor.lifecycle).toBe("closed");
    expect(predecessor.continuedBy).toBe(successorId);
    expect(checkpointOf(predecessor)!.assignments.length).toBeGreaterThan(1);
    await expect(call({ action: "assign", assignment: bigAssignment(52) })).rejects.toThrow(new RegExp(successorId));
    await expect(handleArrangementUpdate(id, { lifecycle: "active" }, "md", root)).rejects.toThrow(/terminal|continued/);

    // Rotating again reports the successor it already has.
    const again = await rotateArrangement(root, id, pen.id);
    expect(again.alreadyRotated).toBe(true);
    expect(again.successorId).toBe(successorId);
  });

  it("refuses a rotation that cannot fit, changing nothing at all", async () => {
    await resolveAssignments(2);
    await call({ action: "assign", assignment: bigAssignment(50) });
    // Pad to within a few bytes of the cap: adding `continuedBy` and the
    // new lifecycle to the predecessor cannot fit, so the whole rotation
    // must refuse before a single file is written.
    await padArrangement(ARRANGEMENT_MAX_BYTES - 30);
    const arrangementSnapshot = await readFile(arrangementPath(), "utf-8");
    const runtimeSnapshot = await readFile(runtimeFile(), "utf-8");

    await expect(rotateArrangement(root, id, pen.id)).rejects.toThrow(/capacity reached/);

    expect(loadArrangementsSafe(root).arrangements.map(a => a.id)).toEqual([id]);
    expect(await readFile(arrangementPath(), "utf-8")).toBe(arrangementSnapshot);
    expect(await readFile(runtimeFile(), "utf-8")).toBe(runtimeSnapshot);
    expect(currentArrangement().lifecycle).toBe("active");
    expect(currentArrangement().continuedBy).toBeUndefined();
  });

  it("leaves no trace of a coordination write started inside the rotation's critical section", async () => {
    await resolveAssignments(1);
    await call({ action: "assign", assignment: bigAssignment(50) });
    const ticketId = await earmarkedTicket();

    // What this pins, exactly: the rival coordination write STARTS inside
    // the rotation's critical section (the barrier fires after the
    // rotation has taken the strict project lock and read its arrangement,
    // runtime and item snapshots, and before its single transaction
    // commits) and its effect is absent from every persisted file
    // afterwards. It asserts that ordering and those outcomes; it does not
    // itself prove where the rival was blocked, so it is not evidence
    // about lock-acquisition timing.
    let rival: Promise<{ error: string } | unknown> | undefined;
    hooks.beforeItemWrite = async () => {
      rival = coordinateDuet(root, {
        id, clientTaskId: pen.id, expectedSessionId: session, expectedRevision: revision,
        action: "assign", assignment: bigAssignment(51),
      } as DuetOperation).catch((error: unknown) => ({ error: String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    };

    const rotated = await rotateArrangement(root, id, pen.id);
    // The barrier really fired inside the critical section (it nulls itself
    // when consumed), so this scenario is not vacuously green.
    expect(hooks.beforeItemWrite).toBeNull();
    expect(rival).toBeDefined();
    const rivalResult = (await rival) as { error?: string };

    expect(rotated.alreadyRotated).toBe(false);
    expect(rotated.carriedAssignments).toEqual(["work-50"]);
    expect(rotated.carriedEarmarks).toEqual([ticketId]);
    // The rival never landed on the rotated arrangement.
    expect(rivalResult.error).toBeDefined();
    expect(rivalResult.error).toMatch(/continued by|revision|session|lock/i);

    // Exactly one successor, and no half-applied state anywhere.
    const arrangements = loadArrangementsSafe(root).arrangements;
    expect(arrangements.map(a => a.id).sort()).toEqual([id, rotated.successorId].sort());
    const predecessor = currentArrangement();
    expect(predecessor.lifecycle).toBe("closed");
    expect(predecessor.continuedBy).toBe(rotated.successorId);
    const predecessorRuntime = JSON.parse(await readFile(runtimeFile(), "utf-8"));
    const successorView = readDuetCoordination(root, currentArrangement(rotated.successorId));
    for (const assignments of [predecessorRuntime.assignments, successorView.state!.assignments]) {
      expect(assignments.map((a: any) => a.input?.id ?? a.id)).not.toContain("work-51");
    }
    expect(successorView.state!.assignments.map((a: any) => a.input?.id ?? a.id)).toEqual(["work-50"]);
    expect(successorView.route.status).toBe("current");
    const { state: projectAfter } = await loadProject(root);
    expect(projectAfter.tickets.find(t => t.id === ticketId)!.earmark!.arrangementId).toBe(rotated.successorId);
  });

  it("refuses rotation without pen authority or a verified return route", async () => {
    await resolveAssignments(1);
    const snapshot = await readFile(arrangementPath(), "utf-8");
    await expect(rotateArrangement(root, id, worker.id)).rejects.toThrow(/pen/);
    expect(await readFile(arrangementPath(), "utf-8")).toBe(snapshot);
    expect(loadArrangementsSafe(root).arrangements).toHaveLength(1);

    // Rotate the coordination session so the route is stale, not current.
    const previous = session;
    session = randomUUID();
    await call({ action: "start", expectedSessionId: previous, newSessionId: session, mode: "native-return" });
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("stale");
    await expect(rotateArrangement(root, id, pen.id)).rejects.toThrow(/verified return route/);
    expect(loadArrangementsSafe(root).arrangements).toHaveLength(1);
  });

  it("reports capacity on the arrangement and earmark get surfaces", async () => {
    await resolveAssignments(2);
    const ticketId = await earmarkedTicket();

    const arrangementJson = JSON.parse(handleDuetGet(id, await ctxFor("json")).output);
    expect(arrangementJson.data.capacity).toMatchObject({ max: ARRANGEMENT_MAX_BYTES });
    expect(arrangementJson.data.capacity.bytes).toBeGreaterThan(0);
    expect(arrangementJson.data.capacity.checkpointBytes).toBeGreaterThan(0);
    expect(arrangementJson.data.capacity.pct).toBeGreaterThan(0);

    const earmarkJson = JSON.parse(handleEarmarkGet(ticketId, await ctxFor("json")).output);
    expect(earmarkJson.data.capacity).toMatchObject({ max: ARRANGEMENT_MAX_BYTES });

    // An arrangement that cannot be resolved from this root reports a
    // reason, never a fabricated number.
    const { state: projectState } = await loadProject(root);
    const ticket = projectState.tickets.find(t => t.id === ticketId)!;
    await writeTicketUnlocked({ ...ticket, earmark: { ...ticket.earmark!, arrangementId: "a-ffffffffffffffff" } }, root);
    const orphanJson = JSON.parse(handleEarmarkGet(ticketId, await ctxFor("json")).output);
    expect(orphanJson.data.capacity).toBeNull();
    expect(orphanJson.data.capacityReason).toContain("a-ffffffffffffffff");
  });

  /**
   * ISS-1191's second ACCEPTANCE item. The two arrangements that actually
   * hit the wall (63,315 and 60,552 bytes) are in another project's
   * `.story/`, so they are reproduced here at their exact sizes and in
   * their measured shape (12 assignments: 5 resolved, 4 needs-review, 3
   * assigned; one receipt), with no identities from that project.
   */
  it.each([63_315, 60_552])("loads a pre-fix %i-byte arrangement, compacts it under the cap, and accepts the next assign", async (targetBytes) => {
    await buildPreFixArrangement(targetBytes);
    expect(await arrangementBytes()).toBe(targetBytes);

    // It loads (bounded read) and reads as consistent under the delimited
    // legacy tolerance, which is what a client written before this fix left
    // behind.
    const loaded = loadArrangementsSafe(root);
    expect(loaded.warnings).toEqual([]);
    expect(readDuetCoordination(root, currentArrangement()).route.status).toBe("current");

    const result = await compactArrangementCheckpoint(root, id, pen.id);
    expect(result.changed).toBe(true);
    expect(result.after.bytes).toBeLessThan(ARRANGEMENT_MAX_BYTES);
    expect(result.after.bytes).toBeLessThan(result.before.bytes);

    // And the write that used to be refused now lands.
    const view = readDuetCoordination(root, currentArrangement());
    const assigned = await coordinateDuet(root, {
      id, clientTaskId: pen.id, expectedSessionId: view.state!.start.sessionId, expectedRevision: view.state!.revision,
      action: "assign", assignment: bigAssignment(13),
    } as DuetOperation) as any;
    expect(assigned.state.assignments.some((a: any) => a.input?.id === "work-13")).toBe(true);
    expect(await arrangementBytes()).toBeLessThanOrEqual(ARRANGEMENT_MAX_BYTES);
  });

  it("names compact and rotate when an arrangement cannot be shrunk under the cap", async () => {
    await ready();
    const arrangement = loadArrangementsSafe(root).arrangements.find(a => a.id === id)!;
    // Pad an unrelated, non-checkpoint field to just under the cap, so the
    // file still loads and compaction cannot recover the space: the refusal
    // must stay actionable and must never blame receipts.
    const headroom = ARRANGEMENT_MAX_BYTES - (await arrangementBytes()) - 200;
    const padded = { ...arrangement, treeProtocol: { pathScopes: ["x".repeat(headroom)] } };
    await writeArrangementUnlocked(padded as any, root);
    expect(await arrangementBytes()).toBeLessThanOrEqual(ARRANGEMENT_MAX_BYTES);
    await expect(call({ action: "assign", assignment: bigAssignment(2) })).rejects.toThrow(
      /Arrangement capacity reached \(\d+ of 65536; checkpoint assignments \d+\): run storybloq arrangement compact/,
    );
  });
});
