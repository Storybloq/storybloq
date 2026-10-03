import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ArrangementSchema, type Arrangement, type ArrangementRebind } from "../models/arrangement.js";
import { ArrangementIdSchema, CLIENT_TASK_ID_PATTERN } from "../models/types.js";
import { DuetOperationSchema, DuetStateSchema, assignmentIdOf, isCompactedAssignment, type DuetOperation, type DuetState, type DuetAssignment, type CheckpointAssignment } from "../models/duet.js";
import { arrangementCapacity, checkpointMatches, compactCheckpoint, type ArrangementCapacity } from "./arrangement-compaction.js";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../models/ticket.js";
import { generateCanonicalId } from "./canonical-id.js";
import { earmarkMatchesArrangement } from "./earmarks.js";
import { ownerTaskForCurrentClient } from "../autonomous/client-profile.js";
import { CliValidationError } from "../cli/helpers.js";
import { loadArrangementsSafe, ARRANGEMENT_MAX_BYTES } from "./arrangement-loader.js";
import { isArrangementConflicted } from "./arrangement-authority.js";
import { readBoundedFile } from "./bounded-read.js";
import { withProjectLock, runTransactionUnlocked, serializeJSON, prepareTicketWrite, prepareIssueWrite } from "./project-loader.js";
import { readRosterWithBus, type BusRosterView, type LivenessProbe } from "./roster-view.js";

export const DUET_STATE_MAX_BYTES = 2 * 1024 * 1024;
const SILENCE_MS = 60 * 60 * 1000;
function refuse(message: string): never { throw new CliValidationError("invalid_input", message); }
function equal(a: unknown, b: unknown): boolean { return serializeJSON(a) === serializeJSON(b); }
type Identity = { client: "claude" | "codex"; id: string };
function same(a: Identity, b: Identity): boolean { return a.client === b.client && a.id === b.id; }
function parties(a: Arrangement) {
  const pen = a.parties.find(p => p.role === "pen")!;
  const worker = a.parties.find(p => p.role === "worker")!;
  return { pen: { client: pen.client, id: pen.identityAnchor }, worker: { client: worker.client, id: worker.identityAnchor } };
}

// Reject links before mkdir, including dangling final links. Canonicalize the
// project root to permit platform aliases such as /tmp -> /private/tmp.
function checkedPath(root: string, parts: string[], create = false): string {
  let path = realpathSync(root);
  const base = path;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const rel = relative(base, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) refuse("Duet path escapes project");
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (i < parts.length - 1 && create) { mkdirSync(path); stat = lstatSync(path); }
      else continue;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) refuse("Unsafe duet path: regular files and directories required");
  }
  return path;
}
function runtimePath(root: string, id: string, create = false) {
  ArrangementIdSchema.parse(id);
  return checkedPath(root, [".story", "duet-sessions", id, "state.json"], create);
}
function loadRuntime(root: string, id: string): DuetState | null {
  const path = runtimePath(root, id);
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const raw = readBoundedFile(path, DUET_STATE_MAX_BYTES);
  if (!raw) refuse("Duet recovery required: runtime is unreadable or exceeds capacity");
  const result = DuetStateSchema.safeParse(JSON.parse(raw));
  if (!result.success || result.data.arrangementId !== id) refuse("Duet recovery required: invalid runtime identity/schema");
  const state = result.data;
  if (new Set(state.assignments.map(assignmentIdOf)).size !== state.assignments.length) refuse("Duet recovery required: duplicate assignment ids");
  return state;
}
export interface DuetRoute {
  status: "current" | "stale" | "missing" | "conflicted" | "recovery-required";
  mode?: "native-return" | "manager-collected";
  reason?: string;
}
export interface DuetView { arrangement: Arrangement; state: DuetState | null; route: DuetRoute }
/**
 * ISS-1191: the tracked projection is now `arrangement-compaction.ts`'s
 * business, and consistency is decided by `checkpointMatches` -- the one
 * place that verdict is computed, so the route status, `compact` and
 * `rotate` can never disagree about whether a checkpoint is faithful.
 */
function routeFor(a: Arrangement, state: DuetState | null): DuetRoute {
  if (isArrangementConflicted(a)) return { status: "conflicted" };
  if (!a.currentCoordinationSessionId) return { status: "missing" };
  const pair = parties(a);
  if (!state || state.start.sessionId !== a.currentCoordinationSessionId || !same(pair.pen, state.pen) || !same(pair.worker, state.worker) || !checkpointMatches(a, state)) return { status: "recovery-required" };
  const receipt = [...(a.communicationReceipts ?? [])].reverse().find(r =>
    r.coordinationSessionId === a.currentCoordinationSessionId && r.nonce === state.nonce &&
    r.mode === state.start.mode && same(r.source, pair.worker) && same(r.destination, pair.pen) && same(r.recorder, pair.pen));
  if (receipt && a.lifecycle === "active") return { status: "current", mode: receipt.mode };
  return { status: a.communicationReceipts?.length ? "stale" : "missing" };
}
export function readDuetCoordination(root: string, arrangement: Arrangement): DuetView {
  try {
    const state = loadRuntime(root, arrangement.id);
    return { arrangement, state, route: routeFor(arrangement, state) };
  } catch {
    return { arrangement, state: null, route: { status: isArrangementConflicted(arrangement) ? "conflicted" : "recovery-required", reason: "Runtime cannot be verified; recover before dispatch" } };
  }
}
/** Ids the tracked checkpoint records as compacted resolved history. */
function archivedIds(arrangement: Arrangement): Set<string> {
  return new Set((arrangement.coordinationCheckpoint?.compactedAssignments ?? []).map(entry => entry.id));
}
export function duetStatusDemandDue(assignment: CheckpointAssignment, now = Date.now()): boolean {
  if (assignment.status === "resolved") return false;
  const last = Date.parse(assignment.lastWorkerActivityAt);
  if (assignment.lastStatusDemandAt && Date.parse(assignment.lastStatusDemandAt) >= last) return false;
  return now - last >= SILENCE_MS;
}
/**
 * ISS-1191: the exact bytes the refusal reports, so a pen who hits the wall
 * is told what actually filled the file (the checkpoint's assignments,
 * measured, not receipts assumed) and which command recovers the space.
 */
function capacityRefusal(arrangement: Arrangement, bytes: number): never {
  const checkpoint = arrangement.coordinationCheckpoint;
  const assignmentBytes = checkpoint === undefined ? 0 : Buffer.byteLength(serializeJSON(checkpoint.assignments));
  return refuse(`Arrangement capacity reached (${bytes} of ${ARRANGEMENT_MAX_BYTES}; checkpoint assignments ${assignmentBytes}): run storybloq arrangement compact ${arrangement.id}, then rotate if still over`);
}

async function persist(root: string, arrangement: Arrangement, state: DuetState, recoveryBackup?: string) {
  // Compaction is automatic on every coordination write, and the same
  // `state.revision` the caller just bumped rides along with it, so a pen
  // holding the pre-compaction revision gets the ordinary CAS refusal.
  const projected = compactCheckpoint(arrangement, state);
  if (!projected.ok) refuse(`Duet recovery required: ${projected.reason}`);
  arrangement.coordinationCheckpoint = projected.checkpoint;
  const arrangementContent = serializeJSON(ArrangementSchema.parse(arrangement));
  const stateContent = serializeJSON(DuetStateSchema.parse(state));
  if (Buffer.byteLength(arrangementContent) > ARRANGEMENT_MAX_BYTES) capacityRefusal(arrangement, Buffer.byteLength(arrangementContent));
  if (Buffer.byteLength(stateContent) > DUET_STATE_MAX_BYTES) refuse("Duet runtime capacity reached; preserve this history and create a new arrangement");
  const aPath = checkedPath(root, [".story", "arrangements", `${arrangement.id}.json`], true);
  const sPath = runtimePath(root, arrangement.id, true);
  const ignorePath = checkedPath(root, [".story", "duet-sessions", ".gitignore"], true);
  await runTransactionUnlocked(root, [
    { op: "write", target: ignorePath, content: "*\n" },
    ...(recoveryBackup === undefined ? [] : [{ op: "write" as const, target: checkedPath(root, [".story", "duet-sessions", arrangement.id, "recovery", `${state.start.sessionId}.json`], true), content: recoveryBackup }]),
    { op: "write", target: aPath, content: arrangementContent },
    { op: "write", target: sPath, content: stateContent },
  ]);
}

/**
 * ISS-1191 scope item 2, the explicit half: `storybloq arrangement compact`.
 *
 * Same authority as any other coordination write (only the pen records
 * coordination state), and the same fail-closed posture as `recover` about
 * a runtime it cannot vouch for. The runtime is classified into three
 * cases, never two, because collapsing "unreadable" into "absent" would let
 * this command overwrite the tracked checkpoint -- the ONLY surviving copy
 * of that history -- from a file it never managed to read.
 */
export interface ArrangementCompactResult {
  view: DuetView;
  changed: boolean;
  before: ArrangementCapacity;
  after: ArrangementCapacity;
}
export async function compactArrangementCheckpoint(root: string, id: string, clientTaskId?: string): Promise<ArrangementCompactResult> {
  ArrangementIdSchema.parse(id);
  let output: ArrangementCompactResult | undefined;
  await withProjectLock(root, { strict: true }, async () => {
    const arrangement = loadArrangementsSafe(root).arrangements.find(a => a.id === id);
    if (!arrangement) throw new CliValidationError("not_found", `Arrangement ${id} not found or unreadable`);
    if (isArrangementConflicted(arrangement)) refuse(`Arrangement ${id} has unresolved merge conflicts; resolve them before compacting`);
    const pair = parties(arrangement);
    const actor = ownerTaskForCurrentClient(clientTaskId);
    if (!actor || !same(actor, pair.pen)) refuse("Only the arrangement pen may compact coordination state");
    const stored = arrangement.coordinationCheckpoint;
    if (!stored) refuse(`Arrangement ${id} has no coordination checkpoint to compact`);
    const before = arrangementCapacity(arrangement);
    // Three cases, never two: `loadRuntime` returns null ONLY for a
    // genuinely absent runtime, and anything unreadable (bad bytes, invalid
    // JSON, wrong identity, oversized) refuses here rather than being
    // treated as absent -- which would overwrite the tracked checkpoint,
    // the only surviving copy of that history, from a file never read.
    let state: DuetState | null;
    try { state = loadRuntime(root, id); }
    catch { refuse("Compaction requires a readable runtime; preserve and recover it before compacting"); }
    const now = new Date().toISOString();

    if (state) {
      if (state.start.sessionId !== arrangement.currentCoordinationSessionId || !same(pair.pen, state.pen) || !same(pair.worker, state.worker) || !checkpointMatches(arrangement, state)) {
        refuse("Readable runtime diverges from the checkpoint; preserve and reconcile both histories before compacting");
      }
      const trial = compactCheckpoint(arrangement, state);
      if (!trial.ok) refuse(`Compaction refused: ${trial.reason}`);
      if (equal(trial.checkpoint, stored)) {
        output = { view: { arrangement, state, route: routeFor(arrangement, state) }, changed: false, before, after: before };
        return;
      }
      // A changed recovery snapshot MUST change its CAS revision, and the
      // runtime's revision moves with it in the same transaction: a pen
      // holding the pre-compaction revision has to get the ordinary stale
      // refusal, never a silently different checkpoint.
      state.revision++;
      arrangement.updatedAt = now;
      await persist(root, arrangement, state);
      output = { view: { arrangement, state, route: routeFor(arrangement, state) }, changed: true, before, after: arrangementCapacity(arrangement) };
      return;
    }

    // Absent runtime: the checkpoint is the only history there is, so it is
    // compacted in place and its own revision is bumped, which is what
    // `recover`'s `expectedRevision` fence reads.
    const asState: DuetState = {
      schemaVersion: 1, arrangementId: id, revision: stored.revision,
      start: { sessionId: stored.sessionId, previousSessionId: null, expectedRevision: stored.revision, mode: "native-return" },
      nonce: randomUUID(), pen: stored.pen, worker: stored.worker, assignments: stored.assignments,
    };
    const trial = compactCheckpoint(arrangement, asState);
    if (!trial.ok) refuse(`Compaction refused: ${trial.reason}`);
    if (equal(trial.checkpoint, stored)) {
      output = { view: { arrangement, state: null, route: routeFor(arrangement, null) }, changed: false, before, after: before };
      return;
    }
    const bumped = compactCheckpoint(arrangement, { ...asState, revision: stored.revision + 1 });
    if (!bumped.ok) refuse(`Compaction refused: ${bumped.reason}`);
    arrangement.coordinationCheckpoint = bumped.checkpoint;
    arrangement.updatedAt = now;
    const content = serializeJSON(ArrangementSchema.parse(arrangement));
    if (Buffer.byteLength(content) > ARRANGEMENT_MAX_BYTES) capacityRefusal(arrangement, Buffer.byteLength(content));
    await runTransactionUnlocked(root, [
      { op: "write", target: checkedPath(root, [".story", "arrangements", `${arrangement.id}.json`], true), content },
    ]);
    output = { view: { arrangement, state: null, route: routeFor(arrangement, null) }, changed: true, before, after: arrangementCapacity(arrangement) };
  });
  return output!;
}

/**
 * ISS-1191 scope item 4: `storybloq arrangement rotate`.
 *
 * The escape hatch for an arrangement compaction can no longer shrink. The
 * successor carries the OPEN work and the verified session forward; the
 * predecessor keeps every byte of history and is closed pointing at its
 * successor. Nothing is deleted and nothing runs in two places.
 *
 * Everything -- reads, authorization, retry detection, size validation and
 * the commit -- happens under one strict project lock, and every file lands
 * through one journaled transaction, so a concurrent coordination or
 * earmark write can neither be lost nor half-applied.
 */
export interface ArrangementRotateResult {
  predecessor: Arrangement;
  successorId: string;
  successor: Arrangement | null;
  carriedAssignments: string[];
  carriedEarmarks: string[];
  alreadyRotated: boolean;
}
export async function rotateArrangement(root: string, id: string, clientTaskId?: string): Promise<ArrangementRotateResult> {
  ArrangementIdSchema.parse(id);
  let output: ArrangementRotateResult | undefined;
  await withProjectLock(root, { strict: true }, async ({ state: projectState }) => {
    const arrangement = loadArrangementsSafe(root).arrangements.find(a => a.id === id);
    if (!arrangement) throw new CliValidationError("not_found", `Arrangement ${id} not found or unreadable`);
    if (arrangement.continuedBy) {
      // Idempotent retry: report the successor this arrangement already has
      // rather than minting a second one.
      output = { predecessor: arrangement, successorId: arrangement.continuedBy, successor: null, carriedAssignments: [], carriedEarmarks: [], alreadyRotated: true };
      return;
    }
    if (isArrangementConflicted(arrangement)) refuse(`Arrangement ${id} has unresolved merge conflicts; resolve them before rotating`);
    if (arrangement.lifecycle !== "active") refuse("Rotation requires an active arrangement");
    const pair = parties(arrangement);
    const actor = ownerTaskForCurrentClient(clientTaskId);
    if (!actor || !same(actor, pair.pen)) refuse("Only the arrangement pen may rotate coordination state");
    if (arrangement.bounds.some(ref => CROSS_NODE_REF_CAPTURE_REGEX.test(ref))) {
      refuse(`Arrangement ${id} has node-qualified bounds; rotation cannot carry federated earmarks. Run storybloq arrangement compact ${id}, or close it and create a successor manually`);
    }
    let state: DuetState | null;
    try { state = loadRuntime(root, id); }
    catch { refuse("Rotation requires a readable runtime; preserve and recover it before rotating"); }
    const route = routeFor(arrangement, state);
    if (route.status !== "current" || !state) {
      refuse(`Rotation requires a verified return route (route is ${route.status}); verify or recover the coordination session before rotating`);
    }
    const now = new Date().toISOString();
    const successorId = generateCanonicalId("a");
    const carried = state.assignments.filter(a => a.status !== "resolved");
    const successorState: DuetState = { ...state, arrangementId: successorId, assignments: carried };
    const { id: _oldId, coordinationCheckpoint: _oldCheckpoint, continuedBy: _oldContinuedBy, communicationReceipts: _oldReceipts, ...carriedFields } = arrangement;
    const successorBase: Arrangement = {
      ...carriedFields,
      id: successorId,
      lifecycle: "active",
      createdDate: now.slice(0, 10),
      updatedAt: now,
      // Only the CURRENT session's receipts: they are what the successor's
      // route verification reads, and older sessions' evidence stays with
      // the history it belongs to.
      communicationReceipts: (arrangement.communicationReceipts ?? []).filter(r => r.coordinationSessionId === state.start.sessionId),
    };
    const projected = compactCheckpoint(successorBase, successorState);
    if (!projected.ok) refuse(`Rotation refused: ${projected.reason}`);
    const successor = ArrangementSchema.parse({ ...successorBase, coordinationCheckpoint: projected.checkpoint });
    const predecessor = ArrangementSchema.parse({ ...arrangement, lifecycle: "closed", continuedBy: successorId, updatedAt: now });

    // Prevalidate every resulting file BEFORE anything is mutated: closing
    // the predecessor grows it too (`continuedBy` plus the new lifecycle),
    // and a rotation that cannot land must change nothing at all.
    const successorContent = serializeJSON(successor);
    const predecessorContent = serializeJSON(predecessor);
    const successorStateContent = serializeJSON(DuetStateSchema.parse(successorState));
    if (Buffer.byteLength(successorContent) > ARRANGEMENT_MAX_BYTES) capacityRefusal(successor, Buffer.byteLength(successorContent));
    if (Buffer.byteLength(predecessorContent) > ARRANGEMENT_MAX_BYTES) capacityRefusal(predecessor, Buffer.byteLength(predecessorContent));
    if (Buffer.byteLength(successorStateContent) > DUET_STATE_MAX_BYTES) refuse("Duet runtime capacity reached; preserve this history before rotating");

    const itemWrites: Array<{ op: "write"; target: string; content: string }> = [];
    const carriedEarmarks: string[] = [];
    for (const ticket of projectState.tickets) {
      if (!earmarkMatchesArrangement(ticket.earmark, id)) continue;
      const { target, content } = await prepareTicketWrite({ ...ticket, earmark: { ...ticket.earmark!, arrangementId: successorId } }, root);
      itemWrites.push({ op: "write", target, content });
      carriedEarmarks.push(ticket.id);
    }
    for (const issue of projectState.issues) {
      if (!earmarkMatchesArrangement(issue.earmark, id)) continue;
      const { target, content } = await prepareIssueWrite({ ...issue, earmark: { ...issue.earmark!, arrangementId: successorId } }, root);
      itemWrites.push({ op: "write", target, content });
      carriedEarmarks.push(issue.id);
    }

    await runTransactionUnlocked(root, [
      { op: "write", target: checkedPath(root, [".story", "duet-sessions", ".gitignore"], true), content: "*\n" },
      { op: "write", target: checkedPath(root, [".story", "arrangements", `${successorId}.json`], true), content: successorContent },
      { op: "write", target: runtimePath(root, successorId, true), content: successorStateContent },
      ...itemWrites,
      { op: "write", target: checkedPath(root, [".story", "arrangements", `${id}.json`], true), content: predecessorContent },
    ]);
    output = { predecessor, successorId, successor, carriedAssignments: carried.map(assignmentIdOf), carriedEarmarks, alreadyRotated: false };
  });
  return output!;
}

/**
 * ISS-1290: `storybloq arrangement rebind`, owner-authorized succession.
 *
 * The parties of an arrangement are never edited in place. A rebind makes a
 * successor with exactly one party replaced and closes the original with
 * `continuedBy`, so the history of who held each role stays in the files.
 *
 * What travels is the TRACKED checkpoint, never the runtime: the old pen's
 * runtime may be on a machine this one cannot see. The nonce, the receipts
 * and the coordination session never travel, so the new pen must `start`
 * (which seeds from the carried checkpoint) and prove the return route
 * before any dispatch.
 *
 * Authorization is an attributed claim, not verification. The current pen
 * may always rebind. Anyone else may only when this machine's roster shows
 * no live pen seat AND the read is conclusive; liveness is machine-local, and
 * the audit records how it was judged.
 */
export interface ArrangementRebindInput {
  role: "pen" | "worker";
  to: string;
  client?: "claude" | "codex";
  evidence: string;
  clientTaskId?: string;
}
export interface ArrangementRebindResult {
  predecessor: Arrangement;
  successorId: string;
  successor: Arrangement;
  role: "pen" | "worker";
  from: Identity;
  to: Identity;
  recordedBy: Identity;
  evidence: string;
  penLiveness: ArrangementRebind["penLiveness"];
  livenessCause: string | null;
  carriedAssignments: string[];
  archivedAssignments: string[];
  carriedEarmarks: string[];
}
export const REBIND_EVIDENCE_MAX = 4000;

/**
 * The first reason this roster view cannot prove the pen is absent, or null.
 * Structured fields only: a truncated read or any global uncertainty could
 * hide the pen's seat, and an unknown Bus probe matters only for the pen's
 * own identity.
 */
function rosterReadInconclusive(view: BusRosterView, pen: Identity): string | null {
  if (view.scanTruncated) return "roster scan cap reached (scanTruncated)";
  if (view.resultTruncated) return "roster result cap reached (resultTruncated)";
  if (view.busScanTruncated) return "Bus endpoint scan cap reached (busScanTruncated)";
  for (const entry of view.readUncertainty ?? []) {
    if (entry.source !== "bus-probe") return `${entry.source}: ${entry.cause}`;
    if (entry.identity && entry.identity.client === pen.client && entry.identity.clientTaskId === pen.id) return `bus-probe: ${entry.cause} for the pen's endpoint`;
  }
  return null;
}

export async function rebindArrangement(
  root: string,
  id: string,
  input: ArrangementRebindInput,
  now = Date.now(),
  probe?: LivenessProbe,
): Promise<ArrangementRebindResult> {
  ArrangementIdSchema.parse(id);
  let output: ArrangementRebindResult | undefined;
  await withProjectLock(root, { strict: true }, async ({ state: projectState }) => {
    const arrangement = loadArrangementsSafe(root).arrangements.find(a => a.id === id);
    if (!arrangement) throw new CliValidationError("not_found", `Arrangement ${id} not found or unreadable`);
    if (arrangement.continuedBy) refuse(`Arrangement ${id} was already continued by ${arrangement.continuedBy}; rebind the successor`);
    if (isArrangementConflicted(arrangement)) refuse(`Arrangement ${id} has unresolved merge conflicts; resolve them before rebinding`);
    if (arrangement.lifecycle === "closed") refuse(`Arrangement ${id} is closed; a closed arrangement cannot be rebound`);
    if (arrangement.bounds.some(ref => CROSS_NODE_REF_CAPTURE_REGEX.test(ref))) {
      refuse(`Arrangement ${id} has node-qualified bounds; rotation cannot carry federated earmarks. Run storybloq arrangement compact ${id}, or close it and create a successor manually`);
    }
    if (input.evidence.trim() === "") refuse("Rebind evidence is required: say who authorized the succession and why");
    if (input.evidence.length > REBIND_EVIDENCE_MAX) refuse(`Rebind evidence exceeds ${REBIND_EVIDENCE_MAX} characters`);
    if (!CLIENT_TASK_ID_PATTERN.test(input.to)) refuse(`Rebind target "${input.to}" is not a valid client task id`);
    const pair = parties(arrangement);
    const from = input.role === "pen" ? pair.pen : pair.worker;
    const other = input.role === "pen" ? pair.worker : pair.pen;
    const to: Identity = { client: input.client ?? from.client, id: input.to };
    if (same(to, from)) refuse(`${to.client}:${to.id} is already bound as the ${input.role}; nothing to rebind`);
    if (same(to, other)) refuse(`${to.client}:${to.id} is the other party of this arrangement; one task cannot hold both roles`);
    const actor = ownerTaskForCurrentClient(input.clientTaskId);
    if (!actor) refuse("Rebind needs a resolved client task id; pass --client-task-id");
    const recordedBy: Identity = { client: actor.client, id: actor.id };

    // Liveness is read from THIS machine's roster only (machine-local).
    const view = await readRosterWithBus(root, projectState.config, now, probe);
    const live = view.seats.some(s => s.client === pair.pen.client && s.clientTaskId === pair.pen.id && s.agentId === null && s.state === "running" && !s.stale);
    const livenessCause = live ? null : rosterReadInconclusive(view, pair.pen);
    const penLiveness: ArrangementRebind["penLiveness"] = live ? "live" : livenessCause !== null ? "inconclusive" : "not-observed-locally";
    if (!same(recordedBy, pair.pen)) {
      if (live) refuse(`The current pen ${pair.pen.client}:${pair.pen.id} has a live seat on this machine; only the pen may rebind while its seat is live`);
      if (livenessCause !== null) refuse(`Pen liveness could not be established from this machine's roster (${livenessCause}); only the pen may rebind until the roster reads cleanly`);
    }

    // The carried state is the tracked checkpoint. A readable local runtime
    // that disagrees with it means two histories, and neither is chosen here.
    let state: DuetState | null = null;
    try { state = loadRuntime(root, id); } catch { state = null; }
    if (state && !checkpointMatches(arrangement, state)) refuse("Local runtime diverges from the checkpoint; recover or compact first");

    const at = new Date(now).toISOString();
    const successorId = generateCanonicalId("a");
    const {
      id: _oldId, continuedBy: _oldContinuedBy, communicationReceipts: _oldReceipts, currentCoordinationSessionId: _oldSession,
      coordinationCheckpoint: oldCheckpoint, rebind: _oldRebind, _conflicts: _oldConflicts, createdBy: _oldCreatedBy, ...carriedFields
    } = arrangement;
    const successorParties = arrangement.parties.map(p => p.role === input.role ? { role: input.role, client: to.client, identityAnchor: to.id } : p);
    const newPair = input.role === "pen" ? { pen: to, worker: pair.worker } : { pen: pair.pen, worker: to };
    const carriedCheckpoint = oldCheckpoint === undefined ? undefined : {
      ...oldCheckpoint,
      ...newPair,
      assignments: oldCheckpoint.assignments.map(a =>
        input.role === "worker" && !isCompactedAssignment(a) && a.status !== "resolved" ? { ...a, assignee: to } : a),
    };
    const audit: ArrangementRebind = { role: input.role, from: { client: from.client, identityAnchor: from.id }, to: { client: to.client, identityAnchor: to.id }, evidence: input.evidence, recordedBy, penLiveness, at };
    const successor = ArrangementSchema.parse({
      ...carriedFields,
      id: successorId,
      parties: successorParties,
      createdDate: at.slice(0, 10),
      updatedAt: at,
      createdBy: actor.id,
      rebind: audit,
      ...(carriedCheckpoint !== undefined && { coordinationCheckpoint: carriedCheckpoint }),
    });
    const predecessor = ArrangementSchema.parse({ ...arrangement, lifecycle: "closed", continuedBy: successorId, updatedAt: at });
    const successorContent = serializeJSON(successor);
    const predecessorContent = serializeJSON(predecessor);
    if (Buffer.byteLength(successorContent) > ARRANGEMENT_MAX_BYTES) capacityRefusal(successor, Buffer.byteLength(successorContent));
    if (Buffer.byteLength(predecessorContent) > ARRANGEMENT_MAX_BYTES) capacityRefusal(predecessor, Buffer.byteLength(predecessorContent));

    const itemWrites: Array<{ op: "write"; target: string; content: string }> = [];
    const carriedEarmarks: string[] = [];
    for (const ticket of projectState.tickets) {
      if (!earmarkMatchesArrangement(ticket.earmark, id)) continue;
      const { target, content } = await prepareTicketWrite({ ...ticket, earmark: { ...ticket.earmark!, arrangementId: successorId } }, root);
      itemWrites.push({ op: "write", target, content });
      carriedEarmarks.push(ticket.id);
    }
    for (const issue of projectState.issues) {
      if (!earmarkMatchesArrangement(issue.earmark, id)) continue;
      const { target, content } = await prepareIssueWrite({ ...issue, earmark: { ...issue.earmark!, arrangementId: successorId } }, root);
      itemWrites.push({ op: "write", target, content });
      carriedEarmarks.push(issue.id);
    }

    await runTransactionUnlocked(root, [
      { op: "write", target: checkedPath(root, [".story", "arrangements", `${successorId}.json`], true), content: successorContent },
      ...itemWrites,
      { op: "write", target: checkedPath(root, [".story", "arrangements", `${id}.json`], true), content: predecessorContent },
    ]);
    const assignments = oldCheckpoint?.assignments ?? [];
    output = {
      predecessor, successorId, successor, role: input.role, from, to, recordedBy, evidence: input.evidence, penLiveness, livenessCause,
      carriedAssignments: assignments.filter(a => !isCompactedAssignment(a) && a.status !== "resolved").map(assignmentIdOf),
      archivedAssignments: [
        ...(oldCheckpoint?.compactedAssignments ?? []).map(entry => entry.id),
        ...assignments.filter(a => isCompactedAssignment(a) || a.status === "resolved").map(assignmentIdOf),
      ],
      carriedEarmarks,
    };
  });
  return output!;
}

/** Operation identity and caller attribution are claims, never credentials. */
export async function coordinateDuet(root: string, input: DuetOperation): Promise<DuetView> {
  const parsed = DuetOperationSchema.safeParse(input);
  if (!parsed.success) refuse(`Invalid duet operation: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const op = parsed.data;
  let output: DuetView | undefined;
  await withProjectLock(root, { strict: true }, async () => {
    const arrangement = loadArrangementsSafe(root).arrangements.find(a => a.id === op.id);
    if (!arrangement) refuse("Arrangement missing or unreadable; cannot coordinate");
    // ISS-1191: rotation is terminal for the arrangement it closed,
    // regardless of lifecycle -- the successor holds this work now, and the
    // same assignments must never be driven from two files.
    if (arrangement.continuedBy) refuse(`Arrangement ${arrangement.id} was continued by ${arrangement.continuedBy}; coordinate against the successor`);
    if (arrangement.lifecycle !== "active" || isArrangementConflicted(arrangement)) refuse("Coordination requires an active, unconflicted arrangement");
    const pair = parties(arrangement);
    const actor = ownerTaskForCurrentClient(op.clientTaskId);
    if (!actor || !same(actor, pair.pen)) refuse("Only the arrangement pen may record coordination state");
    let state: DuetState | null = null;
    let recoveryBackup: string | undefined;
    try { state = loadRuntime(root, op.id); } catch {
      if (op.action !== "recover") refuse("Duet recovery required: runtime cannot be read safely");
      // Preserve corrupt-but-bounded bytes before replacing them. Unsafe paths
      // and oversized files require manual preservation, never a blind reset.
      const bytes = readBoundedFile(runtimePath(root, op.id), DUET_STATE_MAX_BYTES);
      if (bytes === null) refuse("Recovery requires preserving unreadable runtime before replacement");
      recoveryBackup = bytes;
    }
    if (op.action !== "recover" && arrangement.currentCoordinationSessionId && routeFor(arrangement, state).status === "recovery-required") refuse("Duet recovery required: historical runtime is missing or does not match arrangement");
    const finish = () => { output = { arrangement, state, route: routeFor(arrangement, state) }; };
    if ((op.action === "start" || op.action === "recover") && arrangement.currentCoordinationSessionId === op.newSessionId && state) {
      if (state.start.previousSessionId !== op.expectedSessionId || state.start.expectedRevision !== op.expectedRevision || state.start.mode !== op.mode || state.start.recoveryEvidence !== (op.action === "recover" ? op.recoveryEvidence : undefined)) refuse("Session start retry conflicts with original request");
      finish(); return;
    }
    if ((arrangement.currentCoordinationSessionId ?? null) !== op.expectedSessionId) refuse("Stale coordination session; reload before writing");
    if (!state && op.action !== "start" && op.action !== "recover") refuse("Duet recovery required: start coordination first");
    // ISS-1290: a rebind successor's first start seeds from the carried
    // checkpoint, so its open work survives the first persist and its
    // revision continues; every other start is unchanged.
    const seed = op.action === "start" && !state && !arrangement.currentCoordinationSessionId && arrangement.rebind && arrangement.coordinationCheckpoint
      ? arrangement.coordinationCheckpoint : undefined;
    const checkRevision = () => { if ((state?.revision ?? seed?.revision ?? 0) !== op.expectedRevision) refuse("Stale duet revision; reload before writing"); };
    const now = new Date().toISOString();
    if (op.action === "recover") {
      const checkpoint = arrangement.coordinationCheckpoint;
      if (routeFor(arrangement, state).status !== "recovery-required") refuse("Runtime is healthy; use start to rotate normally");
      if (state) refuse("Readable runtime diverges from checkpoint; preserve and reconcile both histories before recovery");
      if (!checkpoint || checkpoint.sessionId !== op.expectedSessionId || checkpoint.revision !== op.expectedRevision || !same(checkpoint.pen, pair.pen) || !same(checkpoint.worker, pair.worker)) refuse("Recovery checkpoint does not match session, revision and parties");
      if (op.newSessionId === op.expectedSessionId || (arrangement.communicationReceipts ?? []).some(r => r.coordinationSessionId === op.newSessionId)) refuse("Recovery requires a fresh coordination session id");
      state = { schemaVersion: 1, arrangementId: op.id, revision: checkpoint.revision, start: { sessionId: op.newSessionId, previousSessionId: op.expectedSessionId, expectedRevision: op.expectedRevision, mode: op.mode, recoveryEvidence: op.recoveryEvidence }, nonce: randomUUID(), ...pair, assignments: checkpoint.assignments };
      arrangement.currentCoordinationSessionId = op.newSessionId;
    } else if (op.action === "start") {
      checkRevision();
      if (state && !arrangement.currentCoordinationSessionId) refuse("Duet recovery required: orphan runtime");
      if ((arrangement.communicationReceipts ?? []).some(r => r.coordinationSessionId === op.newSessionId)) refuse("Coordination session id has already been used");
      state = { schemaVersion: 1, arrangementId: op.id, revision: state?.revision ?? seed?.revision ?? 0, start: { sessionId: op.newSessionId, previousSessionId: op.expectedSessionId, expectedRevision: op.expectedRevision, mode: op.mode }, nonce: randomUUID(), ...pair, assignments: state?.assignments ?? seed?.assignments ?? [] };
      arrangement.currentCoordinationSessionId = op.newSessionId;
    } else if (op.action === "receipt") {
      const receipt = op.receipt;
      if (receipt.nonce !== state!.nonce || receipt.mode !== state!.start.mode || !same(receipt.source, pair.worker) || !same(receipt.destination, pair.pen)) refuse("Receipt does not match current challenge, mode and parties");
      const existing = arrangement.communicationReceipts?.find(r => r.coordinationSessionId === op.expectedSessionId && r.id === receipt.id);
      if (existing) {
        const { coordinationSessionId: _s, recorder: _r, ...content } = existing;
        if (!equal(content, receipt)) refuse("Receipt retry conflicts with immutable evidence");
        finish(); return;
      }
      checkRevision();
      if (Date.parse(receipt.observedAt) > Date.now() + 300_000) refuse("Receipt observation is in the future");
      arrangement.communicationReceipts = [...(arrangement.communicationReceipts ?? []), { ...receipt, coordinationSessionId: op.expectedSessionId, recorder: pair.pen }];
    } else if (op.action === "assign") {
      // ISS-1191: identity spans the archive. After a `recover`, an
      // archived assignment is gone from the runtime entirely, so without
      // this check its id could be reused for NEW work while the archive
      // still describes it as resolved history.
      if (archivedIds(arrangement).has(op.assignment.id)) refuse(`Assignment ${op.assignment.id} belongs to compacted resolved history; dispatch under a new assignment id`);
      const existing = state!.assignments.find(a => assignmentIdOf(a) === op.assignment.id);
      if (existing) {
        if (isCompactedAssignment(existing)) refuse(`Assignment ${op.assignment.id} belongs to compacted resolved history; dispatch under a new assignment id`);
        if (!equal(existing.input, op.assignment)) refuse("Assignment id already has a different immutable scope");
        finish(); return;
      }
      checkRevision();
      if (routeFor(arrangement, state).status !== "current") refuse("Verify the return route before dispatch");
      state!.assignments.push({ input: op.assignment, dispatchSessionId: op.expectedSessionId, assignee: pair.worker, status: "assigned", createdAt: now, lastWorkerActivityAt: now, events: [] });
    } else {
      if (archivedIds(arrangement).has(op.assignmentId)) refuse(`Assignment ${op.assignmentId} belongs to compacted resolved history; resolved assignments cannot be reopened`);
      const found = state!.assignments.find(a => assignmentIdOf(a) === op.assignmentId);
      if (found && isCompactedAssignment(found)) refuse("Resolved assignments cannot be reopened");
      const assignment: DuetAssignment | undefined = found as DuetAssignment | undefined;
      if (!assignment) refuse("Unknown assignment; recover its identity before updating");
      const event = op.event;
      const existing = assignment.events.find(e => e.input.id === event.id);
      if (existing) {
        if (!equal(existing.input, event)) refuse("Event retry conflicts with original content");
        finish(); return;
      }
      if (event.kind === "report") {
        const duplicate = assignment.events.find(e => e.input.kind === "report" && e.input.reportId === event.reportId);
        if (duplicate) {
          const { id: _oldId, ...oldContent } = duplicate.input;
          const { id: _newId, ...newContent } = event;
          if (!equal(oldContent, newContent)) refuse("Report id conflicts with recorded report");
          finish(); return;
        }
      }
      checkRevision();
      if (assignment.status === "resolved") refuse("Resolved assignments cannot be reopened");
      if (event.kind === "review") {
        const latest = [...assignment.events].reverse().find(e => e.input.kind === "report");
        if (assignment.status !== "needs-review" || latest?.input.reportId !== event.reportId) refuse("Review must acknowledge the latest reported result");
        assignment.status = "resolved";
      }
      if (event.kind === "report") assignment.status = "needs-review";
      if (event.kind === "question") assignment.status = "needs-attention";
      if (["progress", "question", "report"].includes(event.kind)) assignment.lastWorkerActivityAt = now;
      if (event.kind === "cursor") {
        if (event.cursor === undefined) refuse("Cursor event requires a collection cursor");
        assignment.cursor = event.cursor;
      }
      if (event.kind === "status-demand") {
        if (!duetStatusDemandDue(assignment)) refuse("Status demand requires 60 silent minutes and no previous demand in this interval");
        assignment.lastStatusDemandAt = now;
      }
      assignment.events.push({ input: event, recordedAt: now });
    }
    state!.revision++;
    arrangement.updatedAt = now;
    await persist(root, arrangement, state!, recoveryBackup);
    finish();
  });
  return output!;
}
