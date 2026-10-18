/**
 * T-538 S2: the setup engine (plan v5 1a-1f, 3, 6). One call applies an
 * approved setup payload to a folder: it bootstraps the ledger when there is
 * none, records the payload in a progress note, then runs each step under its
 * own project lock hold, recording a receipt for every step in the progress
 * note in the same transaction as the step's ledger writes. The progress note
 * is archived last, so any interruption leaves a setup that can be resumed
 * from the ledger alone.
 *
 * Exit codes: 0 applied (or already complete), 2 refused with nothing
 * written, 3 stopped and resumable, 4 stopped on an ambiguity the owner
 * resolves, 7 the project lock is busy.
 *
 * Lock ownership: bootstrap holds the raw `.story/.lock` (no initialized
 * project to load yet); every later step holds `withProjectLock`. No public
 * handler is ever called; only unlocked primitives, whose writes the engine
 * commits itself.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import {
  atomicCreate,
  atomicWrite,
  fencedUnlink,
  guardPath,
  invalidateResolutionWriteContext,
  prepareConfigWrite,
  prepareIssueWrite,
  prepareNoteWrite,
  prepareRoadmapWrite,
  prepareTicketWrite,
  resolveActor,
  runTransactionUnlocked,
  serializeJSON,
  SETUP_BOOTSTRAP_MANIFEST,
  withBootstrapLock,
  withProjectLock,
  type LoadResult,
} from "./project-loader.js";
import { ProjectLoaderError, IMMUTABLE_EVIDENCE_SCHEMA_VERSION } from "./errors.js";
import { localDateOf } from "./local-date.js";
import { STORY_GITIGNORE_ENTRIES } from "./init.js";
import { allocateTeamIssueId, allocateTeamNoteId, nextIssueID, nextNoteID } from "./id-allocation.js";
import { reserveDisplayId } from "./remote-refs.js";
import { prepareNewTicketUnlocked } from "../cli/commands/ticket.js";
import { buildCheckpointTicketUnlocked, prepareCheckpointCreateWrite } from "./checkpoint-lifecycle.js";
import { enableCheckpointsStampUnlocked } from "./checkpoint-enable.js";
import { computeInitialStages } from "./verification-activation.js";
import { validateProject } from "./validation.js";
import { saveSnapshot } from "./snapshot.js";
import { recommend } from "./recommend.js";
import { parseSetupMeta } from "./setup-meta.js";
import {
  parseSetupPayload,
  renderSetupPayload,
  SetupPayloadError,
  validateSetupPayload,
  type SetupPayload,
} from "./setup-payload.js";
import type { ProjectState } from "./project-state.js";
import type { Config } from "../models/config.js";
import type { Roadmap } from "../models/roadmap.js";
import type { Note } from "../models/note.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";

export type SetupExitCode = 0 | 2 | 3 | 4 | 7;

export interface SetupApplyResult {
  readonly exitCode: SetupExitCode;
  /** Narration, one line per write, then the final `Setup applied:` or `Setup stopped:` line. */
  readonly lines: readonly string[];
  readonly setupId: string | null;
}

export interface SetupApplyOptions {
  /** How long each lock acquisition waits before the run exits 7. */
  readonly lockDeadlineMs?: number;
}

/**
 * Test seam: called after each durable write with the point's name, so a
 * test can interrupt the run there. Not reachable through any CLI or MCP
 * input.
 */
export const setupApplySeams: { fault: (point: string) => void | Promise<void> } = {
  fault: () => {},
};

/** One ambiguity, as the line exit 4 prints for it (plan v5 2b). */
export interface SetupAmbiguity {
  readonly class: string;
  readonly target: string;
  readonly observed: string;
  readonly expected: string;
  readonly resolutions: readonly string[];
}

export function ambiguityLine(a: SetupAmbiguity): string {
  return `Ambiguity: ${a.class} · ${a.target} · observed ${a.observed}; expected ${a.expected} · resolutions: ${a.resolutions.join(" | ")}`;
}

class SetupStop extends Error {
  constructor(
    readonly exitCode: 2 | 3 | 4,
    readonly reason: string,
    readonly detail: readonly string[] = [],
  ) {
    super(reason);
    this.name = "SetupStop";
  }
}

function ambiguity(a: SetupAmbiguity): SetupStop {
  return new SetupStop(4, `the owner must resolve ${a.class} at ${a.target}`, [ambiguityLine(a)]);
}

// --- Digests ---------------------------------------------------------------

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const digestOf = (value: unknown): string => sha256(serializeJSON(value));

/** The approved package alone: what the owner approved, without what the engine records later. */
export function approvedPayload(p: SetupPayload): Omit<SetupPayload, "receipts" | "amendments" | "preImages" | "frozen"> {
  const { receipts: _r, amendments: _a, preImages: _p, frozen: _f, ...approved } = p;
  return approved;
}

/** The revision finalization is bound to: the approved package plus its ordered amendments (plan v5 6a). */
export function effectiveRevision(p: SetupPayload): string {
  return digestOf({ approved: approvedPayload(p), amendments: p.amendments });
}

/** Setup-owned fields per entity (plan v5 1d); the digest a receipt records. */
export const ownedDigest = {
  phase: (phase: { id: string; name: string; label: string; description: string }, position: number) =>
    digestOf({ id: phase.id, name: phase.name, label: phase.label, description: phase.description, position }),
  ticket: (t: Ticket) => {
    const raw = t as Ticket & { setup?: unknown; ownerCheckpoint?: { digest?: string } };
    return digestOf({ title: t.title, type: t.type, phase: t.phase, description: t.description, setup: raw.setup ?? null, checkpoint: raw.ownerCheckpoint?.digest ?? null });
  },
  issue: (i: Issue) => digestOf({ title: i.title, impact: i.impact, components: i.components, setup: (i as Issue & { setup?: unknown }).setup ?? null }),
  config: (c: Config) => {
    const stages = (c as Config & { recipeOverrides?: { stages?: unknown } }).recipeOverrides?.stages ?? null;
    return digestOf({ project: c.project, type: c.type, language: c.language, stages });
  },
  edges: (ids: readonly string[]) => digestOf([...ids].sort()),
  bytes: (content: string) => sha256(content),
};

// --- The progress note ------------------------------------------------------

interface Progress {
  readonly note: Note;
  readonly payload: SetupPayload;
}

function progressContent(p: SetupPayload): string {
  return `Setup ${p.setupId} is in progress. Resume it with \`storybloq setup-apply --resume --setup ${p.setupId}\`.\n\n${renderSetupPayload(p)}`;
}

function progressNote(id: string, displayId: string | undefined, p: SetupPayload, today: string): Note {
  return {
    id,
    ...(displayId !== undefined && { displayId }),
    title: `Setup ${p.setupId} progress`,
    content: progressContent(p),
    tags: ["setup"],
    status: "active",
    createdDate: today,
    updatedDate: today,
    setup: { setupId: p.setupId, record: "progress" },
  } as Note;
}

function findProgress(state: ProjectState, setupId: string, status: "active" | "archived"): Note[] {
  return state.notes.filter((n) => {
    if (n.status !== status) return false;
    const meta = parseSetupMeta("note", n);
    return meta.kind === "record" && meta.meta.record === "progress" && meta.meta.setupId === setupId;
  });
}

function readProgress(state: ProjectState, setupId: string): Progress {
  const notes = findProgress(state, setupId, "active");
  if (notes.length !== 1) {
    throw ambiguity({
      class: "progress notes",
      target: setupId,
      observed: `${notes.length} active progress notes`,
      expected: "exactly one",
      resolutions: notes.length > 1 ? [...notes.map((n) => `keep ${n.id}`), "stop"] : ["stop"],
    });
  }
  return { note: notes[0]!, payload: parseSetupPayload(notes[0]!.content) };
}

async function progressWrite(root: string, progress: Progress, payload: SetupPayload, today: string, archived = false) {
  const note = { ...progress.note, content: progressContent(payload), updatedDate: today, ...(archived && { status: "archived" as const }) };
  return prepareNoteWrite(note as Note, root);
}

function withReceipt(p: SetupPayload, receipt: SetupPayload["receipts"][number]): SetupPayload {
  return { ...p, receipts: [...p.receipts, receipt] };
}

const hasReceipt = (p: SetupPayload, step: string) => p.receipts.some((r) => r.step === step);

// --- Lookup by key -----------------------------------------------------------

function keyedTicket(state: ProjectState, setupId: string, key: string): Ticket | undefined {
  return state.tickets.find((t) => {
    const meta = parseSetupMeta("ticket", t);
    return meta.kind === "item" && meta.meta.setupId === setupId && meta.meta.key === key && meta.meta.supersededBy === undefined;
  });
}

function keyedIssue(state: ProjectState, setupId: string, key: string): Issue | undefined {
  return state.issues.find((i) => {
    const meta = parseSetupMeta("issue", i);
    return meta.kind === "item" && meta.meta.setupId === setupId && meta.meta.key === key && meta.meta.supersededBy === undefined;
  });
}

// --- Paths ------------------------------------------------------------------

/** A payload path inside the project, refused at the write boundary when it is not. */
function insideProject(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..") || resolve(root, rel) !== target) {
    throw new SetupStop(2, `the path ${path} leaves the project`);
  }
  return target;
}

const proposedPath = (target: string, setupId: string) => `${target}.storybloq-${setupId}.proposed`;

/**
 * A user-owned file (plan v5 1f): created, never replaced. Absent: created.
 * Present with the same bytes: done. Present with other bytes: setup's
 * version is left beside it as `.proposed` and the run stops for the owner.
 */
async function createUserFile(root: string, path: string, content: string, setupId: string, klass: string): Promise<"created" | "present"> {
  const target = insideProject(root, path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await atomicCreate(target, content);
    return "created";
  } catch (err) {
    if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
  }
  const current = await readFile(target, "utf-8");
  if (current === content) return "present";
  try {
    await atomicCreate(proposedPath(target, setupId), content);
  } catch (err) {
    if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
  }
  throw ambiguity({
    class: klass,
    target: path,
    observed: `${current.length} bytes that are not setup's`,
    expected: `setup's ${content.length} bytes, left beside it as ${posix.basename(path)}.storybloq-${setupId}.proposed`,
    resolutions: ["keep-current", "stop"],
  });
}

// --- Bootstrap (plan v5 1b) -------------------------------------------------

interface OwnedFile {
  readonly target: string;
  readonly digest: string;
  readonly content: string;
}

interface BootstrapManifest {
  readonly setupId: string;
  readonly attempt: number;
  readonly payloadDigest: string;
  readonly payload: SetupPayload;
  readonly owned: OwnedFile[];
  readonly publish: OwnedFile | null;
}

const ENTITY_DIRS = ["tickets", "issues", "handovers", "notes", "lessons"];

function freshConfig(p: SetupPayload): Config {
  return {
    version: 2,
    schemaVersion: IMMUTABLE_EVIDENCE_SCHEMA_VERSION,
    project: p.project.name,
    type: p.project.type,
    language: p.project.language,
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  } as Config;
}

async function readManifest(wrap: string): Promise<BootstrapManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(wrap, SETUP_BOOTSTRAP_MANIFEST), "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as BootstrapManifest;
  } catch {
    throw ambiguity({ class: "corrupted bootstrap manifest", target: `.story/${SETUP_BOOTSTRAP_MANIFEST}`, observed: "unparseable JSON", expected: "a setup bootstrap manifest", resolutions: ["stop"] });
  }
}

function manifestProblem(m: BootstrapManifest, p: SetupPayload): SetupStop | null {
  if (m.setupId !== p.setupId) {
    return ambiguity({
      class: "bootstrap manifest of another setup",
      target: `.story/${SETUP_BOOTSTRAP_MANIFEST}`,
      observed: `setup ${m.setupId}`,
      expected: `setup ${p.setupId}`,
      resolutions: [`resume ${m.setupId}`, "remove it by hand", "stop"],
    });
  }
  if (digestOf(m.payload) !== m.payloadDigest) {
    return ambiguity({ class: "corrupted bootstrap manifest", target: `.story/${SETUP_BOOTSTRAP_MANIFEST}`, observed: "a payload whose digest does not match", expected: m.payloadDigest, resolutions: ["stop"] });
  }
  if (digestOf(approvedPayload(validateSetupPayload(m.payload))) !== digestOf(approvedPayload(p))) {
    return ambiguity({ class: "payload differs from the setup in progress", target: p.setupId, observed: "another approved package", expected: "the package this setup started with", resolutions: ["stop"] });
  }
  return null;
}

/**
 * Builds the ledger in place under the project lock, every file created and
 * never replaced, the manifest naming each before it is created, `config.json`
 * published last by a no-replace create, and the manifest removed after it.
 * Returns false when another writer published a project first.
 */
async function bootstrap(root: string, p: SetupPayload, out: string[], options: SetupApplyOptions): Promise<boolean> {
  const wrap = join(root, ".story");
  const manifestPath = join(wrap, SETUP_BOOTSTRAP_MANIFEST);
  return withBootstrapLock(root, async () => {
    if (existsSync(join(wrap, "config.json"))) return false;
    await mkdir(wrap, { recursive: true });
    let manifest = await readManifest(wrap);
    if (manifest) {
      const problem = manifestProblem(manifest, p);
      if (problem) throw problem;
      manifest = { ...manifest, attempt: manifest.attempt + 1 };
      await atomicWrite(manifestPath, serializeJSON(manifest));
    } else {
      manifest = { setupId: p.setupId, attempt: 1, payloadDigest: digestOf(p), payload: p, owned: [], publish: null };
      await atomicCreate(manifestPath, serializeJSON(manifest));
      await setupApplySeams.fault("bootstrap:manifest");
    }
    const approved = manifest.payload;
    for (const dir of ENTITY_DIRS) await mkdir(join(wrap, dir), { recursive: true });

    const today = localDateOf(new Date());
    const intended = async (target: string): Promise<string> => {
      if (target === "roadmap.json") return (await prepareRoadmapWrite({ title: approved.project.name, date: today, phases: [], blockers: [] } as Roadmap, root)).content;
      if (target === ".gitignore") return STORY_GITIGNORE_ENTRIES.join("\n") + "\n";
      return (await prepareNoteWrite(progressNote("N-001", undefined, approved, today), root)).content;
    };
    for (const target of ["roadmap.json", ".gitignore", "notes/N-001.json"]) {
      let owned: OwnedFile | undefined = manifest.owned.find((o) => o.target === target);
      if (!owned) {
        const content = await intended(target);
        owned = { target, digest: sha256(content), content };
        manifest = { ...manifest, owned: [...manifest.owned, owned] };
        await atomicWrite(manifestPath, serializeJSON(manifest));
        await setupApplySeams.fault(`bootstrap:owned:${target}`);
      }
      const path = join(wrap, target);
      if (existsSync(path)) {
        const current = await readFile(path, "utf-8");
        if (sha256(current) !== owned.digest) {
          throw ambiguity({ class: "bootstrap target occupied", target: `.story/${target}`, observed: "a file that is not setup's", expected: `digest ${owned.digest}`, resolutions: ["keep-current", "stop"] });
        }
        continue;
      }
      await atomicCreate(path, owned.content);
      await setupApplySeams.fault(`bootstrap:create:${target}`);
    }

    let publish = manifest.publish;
    if (!publish) {
      const content = (await prepareConfigWrite(freshConfig(approved), root)).content;
      publish = { target: "config.json", digest: sha256(content), content };
      manifest = { ...manifest, publish };
      await atomicWrite(manifestPath, serializeJSON(manifest));
      await setupApplySeams.fault("bootstrap:owned:config.json");
    }
    try {
      await atomicCreate(join(wrap, "config.json"), publish.content);
    } catch (err) {
      if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
      throw publishedByOther();
    }
    await setupApplySeams.fault("bootstrap:publish");
    await fencedUnlink(manifestPath);
    await setupApplySeams.fault("bootstrap:manifest-removed");
    out.push(`-> storybloq · project "${approved.project.name}" created for setup ${approved.setupId}`);
    return true;
  }, { deadlineMs: options.lockDeadlineMs });
}

function publishedByOther(): SetupStop {
  return ambiguity({
    class: "project initialized by someone else during setup",
    target: ".story/config.json",
    observed: "a config.json setup did not write",
    expected: "setup's config.json",
    resolutions: ["stop"],
  });
}

/** `config.json` exists and the manifest is still there: finish a bootstrap that published, or report the clash. */
async function finishPublishedBootstrap(root: string, p: SetupPayload, options: SetupApplyOptions): Promise<void> {
  const wrap = join(root, ".story");
  await withBootstrapLock(root, async () => {
    const manifest = await readManifest(wrap);
    if (!manifest) return;
    const problem = manifestProblem(manifest, p);
    if (problem) throw problem;
    const config = await readFile(join(wrap, "config.json"), "utf-8");
    if (manifest.publish === null || sha256(config) !== manifest.publish.digest) throw publishedByOther();
    await fencedUnlink(join(wrap, SETUP_BOOTSTRAP_MANIFEST));
    await setupApplySeams.fault("bootstrap:manifest-removed");
  }, { deadlineMs: options.lockDeadlineMs });
}

// --- Starting or continuing ---------------------------------------------------

async function allocateNoteId(state: ProjectState, root: string): Promise<{ id: string; displayId?: string }> {
  if (state.config.team?.enabled !== true) return { id: nextNoteID(state.notes) };
  const alloc = allocateTeamNoteId(state.notes);
  if (state.config.team?.idAllocator === "git-refs") return { id: alloc.id, displayId: (await reserveDisplayId(root, "note", state, alloc.id)).displayId };
  return alloc;
}

type Start = { kind: "run" } | { kind: "complete"; report: string };

/**
 * With a project in place: continue this setup's progress note, report a
 * completed setup, or start one on an empty scaffold, recording the
 * scaffold's config and roadmap as pre-images in the same transaction.
 */
async function startOnProject(root: string, p: SetupPayload, out: string[], options: SetupApplyOptions): Promise<Start> {
  let start: Start = { kind: "run" };
  await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
    const active = state.setupInProgress;
    if (active.length > 1) {
      throw ambiguity({ class: "progress notes", target: active.map((a) => a.noteId).join(", "), observed: `${active.length} active progress notes`, expected: "exactly one", resolutions: [...active.map((a) => `keep ${a.noteId}`), "stop"] });
    }
    const mine = active.find((a) => a.setupId === p.setupId);
    if (mine) {
      const stored = parseSetupPayload(state.noteByID(mine.noteId)!.content);
      if (digestOf(approvedPayload(stored)) !== digestOf(approvedPayload(p))) {
        throw ambiguity({ class: "payload differs from the setup in progress", target: p.setupId, observed: "another approved package", expected: "the package this setup started with", resolutions: ["stop"] });
      }
      return;
    }
    if (active.length === 1) {
      throw ambiguity({ class: "another setup in progress", target: active[0]!.noteId, observed: `setup ${active[0]!.setupId}`, expected: `setup ${p.setupId}`, resolutions: [`resume ${active[0]!.setupId}`, "stop"] });
    }
    const archived = findProgress(state, p.setupId, "archived");
    if (archived.length > 0) {
      const done = parseSetupPayload(archived[0]!.content);
      start = { kind: "complete", report: done.frozen?.historicalReport ?? "" };
      return;
    }
    if (!state.isEmptyScaffold) {
      throw new SetupStop(2, "this folder already holds a project; setup-apply runs on an empty folder or an empty scaffold");
    }
    const wrap = join(root, ".story");
    const withPre: SetupPayload = {
      ...p,
      preImages: [
        { target: ".story/config.json", content: await readFile(join(wrap, "config.json"), "utf-8") },
        { target: ".story/roadmap.json", content: await readFile(join(wrap, "roadmap.json"), "utf-8") },
      ],
    };
    const { id, displayId } = await allocateNoteId(state, root);
    const op = await prepareNoteWrite(progressNote(id, displayId, withPre, localDateOf(new Date())), root);
    await runTransactionUnlocked(root, [{ op: "write", ...op }]);
    out.push(`-> storybloq · setup ${p.setupId} started on the existing scaffold (progress note ${displayId ?? id})`);
  });
  if (start.kind === "run") await setupApplySeams.fault("progress");
  return start;
}

// --- Steps ------------------------------------------------------------------

interface StepContext {
  readonly root: string;
  readonly lr: LoadResult;
  readonly progress: Progress;
  readonly today: string;
  readonly out: string[];
}

interface Step {
  readonly id: string;
  readonly run: (ctx: StepContext) => Promise<void>;
}

/** Commits `ops` and the receipt in one transaction under the held lock. */
async function commit(ctx: StepContext, ops: Array<{ target: string; content: string }>, receipt: SetupPayload["receipts"][number], payload = withReceipt(ctx.progress.payload, receipt)): Promise<void> {
  const note = await progressWrite(ctx.root, ctx.progress, payload, ctx.today);
  await runTransactionUnlocked(ctx.root, [...ops, note].map((o) => ({ op: "write" as const, ...o })));
}

function phaseIdOf(p: SetupPayload, key: string): string {
  return p.phases.find((ph) => ph.key === key)!.id;
}

/** The setup blockers of each work item: its own blockedBy plus every checkpoint that gates it. */
function setupBlockers(p: SetupPayload): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of [...p.tickets, ...p.checkpoints]) out.set(item.key, [...item.blockedBy]);
  for (const cp of p.checkpoints) for (const g of cp.gates) out.set(g, [...(out.get(g) ?? []), cp.key]);
  return out;
}

function planSteps(p: SetupPayload): Step[] {
  const steps: Step[] = [];
  if (p.checkpoints.length > 0) steps.push({ id: "enable", run: stepEnable });
  p.phases.forEach((ph) => steps.push({ id: `phase:${ph.key}`, run: (ctx) => stepPhase(ctx, ph.key) }));
  for (const t of p.tickets) steps.push({ id: `item:${t.key}`, run: (ctx) => stepTicket(ctx, t.key) });
  for (const c of p.checkpoints) steps.push({ id: `item:${c.key}`, run: (ctx) => stepCheckpoint(ctx, c.key) });
  for (const i of p.issues) steps.push({ id: `item:${i.key}`, run: (ctx) => stepIssue(ctx, i.key) });
  for (const [key, blockers] of setupBlockers(p)) {
    if (blockers.length > 0) steps.push({ id: `wire:${key}`, run: (ctx) => stepWire(ctx, key, blockers) });
  }
  steps.push({ id: "config", run: stepConfig });
  for (const f of p.governance.files) steps.push({ id: `governance:${posix.normalize(f.path)}`, run: (ctx) => stepGovernance(ctx, f.path, f.content) });
  if (p.git.init) steps.push({ id: "git-init", run: stepGitInit });
  if (p.git.gitignore.length > 0) steps.push({ id: "gitignore", run: stepGitignore });
  steps.push({ id: "freeze", run: stepFreeze });
  steps.push({ id: "setup-note", run: stepSetupNote });
  steps.push({ id: "handover", run: stepHandover });
  steps.push({ id: "validate", run: stepValidate });
  steps.push({ id: "snapshot", run: stepSnapshot });
  steps.push({ id: "archive", run: stepArchive });
  return steps;
}

async function stepEnable(ctx: StepContext): Promise<void> {
  const config = ctx.lr.state.config;
  const stamp = enableCheckpointsStampUnlocked(config, IMMUTABLE_EVIDENCE_SCHEMA_VERSION);
  if (stamp.status === "already") {
    await commit(ctx, [], { step: "enable", target: "config", ownedPre: null, ownedPost: digestOf({ schemaVersion: config.schemaVersion }) });
    return;
  }
  if (config.team?.enabled === true) {
    throw ambiguity({
      class: "schema-5 enable refused",
      target: ".story/config.json",
      observed: `a team ledger at schema ${config.schemaVersion ?? "unset"}`,
      expected: `schema ${IMMUTABLE_EVIDENCE_SCHEMA_VERSION} with immutable checkpoint evidence enabled`,
      resolutions: ["run `storybloq checkpoint enable --immutable-evidence`, then resume", "amend the checkpoints out of the setup", "stop"],
    });
  }
  const op = await prepareConfigWrite(stamp.config, ctx.root);
  await commit(ctx, [op], { step: "enable", target: "config", ownedPre: digestOf({ schemaVersion: config.schemaVersion }), ownedPost: digestOf({ schemaVersion: stamp.config.schemaVersion }) });
  invalidateResolutionWriteContext(ctx.root);
  ctx.out.push(`-> storybloq · immutable checkpoint evidence enabled (schema ${IMMUTABLE_EVIDENCE_SCHEMA_VERSION})`);
}

async function stepPhase(ctx: StepContext, key: string): Promise<void> {
  const p = ctx.progress.payload;
  const ph = p.phases.find((x) => x.key === key)!;
  const roadmap = ctx.lr.state.roadmap;
  if (roadmap.phases.some((x) => x.id === ph.id)) {
    throw ambiguity({ class: "phase id taken", target: `phase ${ph.id}`, observed: "a phase setup did not create", expected: "no phase with this id", resolutions: ["stop"] });
  }
  const phase = { id: ph.id, label: ph.label, name: ph.name, description: ph.description };
  const next = { ...roadmap, phases: [...roadmap.phases, phase] } as Roadmap;
  const op = await prepareRoadmapWrite(next, ctx.root);
  await commit(ctx, [op], { step: `phase:${key}`, target: `phase:${ph.id}`, ownedPre: null, ownedPost: ownedDigest.phase(phase, next.phases.length - 1) });
  ctx.out.push(`-> storybloq · phase "${ph.name}" created (${key})`);
}

function refuseTakenKey(ctx: StepContext, key: string): void {
  const p = ctx.progress.payload;
  const taken = keyedTicket(ctx.lr.state, p.setupId, key) ?? keyedIssue(ctx.lr.state, p.setupId, key);
  if (taken) {
    throw ambiguity({ class: "corrupted receipt state", target: `${key} (${taken.id})`, observed: `an item carrying ${key} with no receipt`, expected: "no item before its create receipt", resolutions: ["stop"] });
  }
}

async function stepTicket(ctx: StepContext, key: string): Promise<void> {
  const p = ctx.progress.payload;
  refuseTakenKey(ctx, key);
  const t = p.tickets.find((x) => x.key === key)!;
  const base = await prepareNewTicketUnlocked({ title: t.title, type: t.type, phase: phaseIdOf(p, t.phase), description: t.description, blockedBy: [], parentTicket: null }, ctx.lr.state, ctx.root);
  const ticket = { ...base, setup: { setupId: p.setupId, key } } as Ticket;
  const op = await prepareTicketWrite(ticket, ctx.root);
  await commit(ctx, [op], { step: `item:${key}`, target: `ticket:${ticket.id}`, ownedPre: null, ownedPost: ownedDigest.ticket(ticket) });
  ctx.out.push(`-> storybloq · ticket ${ticket.displayId ?? ticket.id} "${t.title}" created (${key})`);
}

async function stepCheckpoint(ctx: StepContext, key: string): Promise<void> {
  const p = ctx.progress.payload;
  refuseTakenKey(ctx, key);
  const c = p.checkpoints.find((x) => x.key === key)!;
  const by = await resolveActor(ctx.root);
  const content = { kind: c.kind, evidenceRefs: c.evidenceRefs, ...(c.question !== undefined && { question: c.question }), ...(c.criteria !== undefined && { criteria: c.criteria }) };
  const base = await buildCheckpointTicketUnlocked(ctx.lr.state, ctx.root, { title: c.title, description: c.description, phase: phaseIdOf(p, c.phase), owner: p.ownerLabel, content, evidenceMode: "immutable" }, by);
  const ticket = { ...base, setup: { setupId: p.setupId, key } } as Ticket;
  const op = await prepareCheckpointCreateWrite(ticket, ctx.root);
  await commit(ctx, [op], { step: `item:${key}`, target: `ticket:${ticket.id}`, ownedPre: null, ownedPost: ownedDigest.ticket(ticket) });
  ctx.out.push(`-> storybloq · checkpoint ${ticket.displayId ?? ticket.id} "${c.title}" created (${c.kind}, owner ${p.ownerLabel}, ${key})`);
}

async function stepIssue(ctx: StepContext, key: string): Promise<void> {
  const p = ctx.progress.payload;
  refuseTakenKey(ctx, key);
  const i = p.issues.find((x) => x.key === key)!;
  const state = ctx.lr.state;
  let id: string;
  let displayId: string | undefined;
  if (state.config.team?.enabled === true) {
    const alloc = allocateTeamIssueId(state.issues);
    id = alloc.id;
    displayId = state.config.team?.idAllocator === "git-refs" ? (await reserveDisplayId(ctx.root, "issue", state, id)).displayId : alloc.displayId;
  } else {
    id = nextIssueID(state.issues);
  }
  const impact = i.source === null ? i.body : `${i.body}${i.body === "" ? "" : "\n\n"}Imported from GitHub issue #${i.source}.`;
  const issue = {
    id,
    ...(displayId !== undefined && { displayId }),
    title: i.title,
    status: "open",
    severity: "medium",
    components: i.labels,
    impact: impact === "" ? i.title : impact,
    resolution: null,
    location: [],
    discoveredDate: ctx.today,
    resolvedDate: null,
    relatedTickets: [],
    phase: null,
    setup: { setupId: p.setupId, key },
  } as unknown as Issue;
  const op = await prepareIssueWrite(issue, ctx.root);
  await commit(ctx, [op], { step: `item:${key}`, target: `issue:${id}`, ownedPre: null, ownedPost: ownedDigest.issue(issue) });
  ctx.out.push(`-> storybloq · issue ${displayId ?? id} "${i.title}" created (${key})`);
}

async function stepWire(ctx: StepContext, key: string, blockerKeys: readonly string[]): Promise<void> {
  const p = ctx.progress.payload;
  const state = ctx.lr.state;
  const item = keyedTicket(state, p.setupId, key);
  const blockers = blockerKeys.map((k) => keyedTicket(state, p.setupId, k));
  if (!item || blockers.some((b) => b === undefined)) {
    throw ambiguity({ class: "corrupted receipt state", target: key, observed: "an item or blocker missing after its create receipt", expected: "every keyed item present", resolutions: ["stop"] });
  }
  const setupEdges = blockers.map((b) => b!.id);
  // A union: an edge the owner added is kept, never removed.
  const blockedBy = [...item.blockedBy, ...setupEdges.filter((id) => !item.blockedBy.includes(id))];
  const op = await prepareTicketWrite({ ...item, blockedBy } as Ticket, ctx.root);
  await commit(ctx, [op], { step: `wire:${key}`, target: `ticket:${item.id}`, ownedPre: ownedDigest.edges([]), ownedPost: ownedDigest.edges(setupEdges), edges: setupEdges.map((b): [string, string] => [item.id, b]) });
  ctx.out.push(`-> storybloq · ${item.displayId ?? item.id} wired: blocked by ${blockers.map((b) => b!.displayId ?? b!.id).join(", ")}`);
}

function activationInput(p: SetupPayload) {
  return { level: p.quality.level, verifyApplies: p.quality.verifyApplies, components: p.quality.components };
}

async function stepConfig(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const config = ctx.lr.state.config;
  const { stages } = computeInitialStages(activationInput(p));
  const overrides = (config as Config & { recipeOverrides?: Record<string, unknown> }).recipeOverrides ?? {};
  const existing = (overrides.stages as Record<string, unknown> | undefined) ?? {};
  const next = {
    ...config,
    project: p.project.name,
    type: p.project.type,
    language: p.project.language,
    recipeOverrides: { ...overrides, stages: { ...existing, ...stages } },
  } as Config;
  const op = await prepareConfigWrite(next, ctx.root);
  await commit(ctx, [op], { step: "config", target: "config", ownedPre: ownedDigest.config(config), ownedPost: ownedDigest.config(next) });
  invalidateResolutionWriteContext(ctx.root);
  const on = Object.entries(stages).filter(([, s]) => s.enabled === true).map(([name]) => name);
  ctx.out.push(`-> storybloq · recipe stages written (${p.quality.level}; on: ${on.length > 0 ? on.join(", ") : "none"})`);
}

async function stepGovernance(ctx: StepContext, path: string, content: string): Promise<void> {
  const p = ctx.progress.payload;
  const outcome = await createUserFile(ctx.root, path, content, p.setupId, "user-owned target occupied");
  await setupApplySeams.fault(`governance-created:${posix.normalize(path)}`);
  await commit(ctx, [], { step: `governance:${posix.normalize(path)}`, target: `file:${posix.normalize(path)}`, ownedPre: null, ownedPost: ownedDigest.bytes(content) });
  ctx.out.push(`-> file · ${path} ${outcome === "created" ? "created" : "already present with setup's content"} (${content.length} chars)`);
}

function isGitRepo(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function stepGitInit(ctx: StepContext): Promise<void> {
  if (!isGitRepo(ctx.root)) {
    execFileSync("git", ["init", "--quiet"], { cwd: ctx.root, stdio: "ignore" });
    ctx.out.push(`-> git · repository initialized at ${ctx.root}`);
  }
  await commit(ctx, [], { step: "git-init", target: "git", ownedPre: null, ownedPost: sha256("git repository") });
}

async function stepGitignore(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const target = join(ctx.root, ".gitignore");
  let current: string | null = null;
  try {
    current = await readFile(target, "utf-8");
  } catch { /* absent */ }
  const wanted = p.git.gitignore;
  if (current === null) {
    const content = wanted.join("\n") + "\n";
    await createUserFile(ctx.root, ".gitignore", content, p.setupId, "user-owned target occupied");
    await commit(ctx, [], { step: "gitignore", target: "file:.gitignore", ownedPre: null, ownedPost: ownedDigest.bytes(content) });
    ctx.out.push(`-> git · .gitignore created (${wanted.join(", ")})`);
    return;
  }
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((w) => !lines.has(w));
  if (missing.length > 0) {
    // A change to a file the user owns is never made by the engine (plan v5 1f).
    const proposed = `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${missing.join("\n")}\n`;
    try {
      await atomicCreate(proposedPath(target, p.setupId), proposed);
    } catch (err) {
      if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
    }
    throw ambiguity({ class: "pointer edit owed", target: ".gitignore", observed: `missing ${missing.join(", ")}`, expected: `the entries in .gitignore.storybloq-${p.setupId}.proposed`, resolutions: ["applied", "keep-current", "stop"] });
  }
  await commit(ctx, [], { step: "gitignore", target: "file:.gitignore", ownedPre: null, ownedPost: digestOf([...wanted].sort()) });
  ctx.out.push("-> git · .gitignore already lists the setup entries");
}

// --- Finalization (plan v5 6a) ------------------------------------------------

function userCounts(state: ProjectState, p: SetupPayload) {
  const phases = p.phases.filter((ph) => state.roadmap.phases.some((x) => x.id === ph.id)).length;
  const keyed = (key: string) => keyedTicket(state, p.setupId, key);
  return {
    phases,
    tickets: p.tickets.filter((t) => keyed(t.key)).length,
    checkpoints: p.checkpoints.filter((c) => keyed(c.key)).length,
    issues: p.issues.filter((i) => keyedIssue(state, p.setupId, i.key)).length,
  };
}

/** The core report lines (plan v5 6c), computed once at the freeze from the ledger and kept verbatim. */
export function setupReportLines(state: ProjectState, p: SetupPayload): string[] {
  const counts = userCounts(state, p);
  const { stages, pending } = computeInitialStages(activationInput(p));
  const on = Object.entries(stages).filter(([, s]) => s.enabled === true).map(([name]) => name);
  const keyedIds = new Set(
    [...p.tickets, ...p.checkpoints].map((t) => keyedTicket(state, p.setupId, t.key)?.id).filter((id): id is string => id !== undefined),
  );
  const ready = recommend(state, 10).recommendations.filter((r) => r.kind === "ticket" && keyedIds.has(r.id));
  const label = (r: { id: string; displayId?: string; title: string }) => `${r.displayId ?? r.id} "${r.title}"`;
  const lines = [
    `Setup ${p.setupId}: ${p.project.name} (${p.project.type}, ${p.project.language})`,
    `Created: ${counts.phases} phases, ${counts.tickets} tickets, ${counts.checkpoints} checkpoints, ${counts.issues} issues`,
    `Quality: ${p.quality.level}; stages on: ${on.length > 0 ? on.join(", ") : "none"}`,
    ...pending.map((l) => `Pending: ${l.stage}${l.component === null ? "" : ` (${l.component})`}: ${l.command} (pending: ${l.reason})`),
    `Governance: ${p.governance.files.length > 0 ? p.governance.files.map((f) => f.path).join(", ") : "none"}; canonical facts: ${p.governance.canonicalFactsPath}`,
    ...p.review.lines.map((l) => `Review: ${l}`),
    `Ready to build: ${ready.length > 0 ? ready.map(label).join(", ") : "none"}`,
    `First story: ${ready.length > 0 ? label(ready[0]!) : "none"}`,
  ];
  return lines;
}

function setupNoteContent(p: SetupPayload, report: string): string {
  const coverage = p.coverage.map((c) => `- ${c.requirement} (${c.source}): ${c.text} -> ${c.keys.length > 0 ? c.keys.join(", ") : `deferred: ${c.deferral}`}`);
  return [
    `Setup ${p.setupId} record. Owner: ${p.ownerLabel}. Canonical facts: ${p.governance.canonicalFactsPath}.`,
    "",
    report,
    "",
    "Coverage:",
    ...(coverage.length > 0 ? coverage : ["- none recorded"]),
    "",
  ].join("\n");
}

function handoverContent(p: SetupPayload, report: string): string {
  return [
    `Setup record: ${p.setupId} handover`,
    "",
    `# Setup ${p.setupId}`,
    "",
    report,
    "",
    "The setup is complete; the progress note is archived. Start with the first story above.",
    "",
  ].join("\n");
}

async function stepFreeze(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const report = setupReportLines(ctx.lr.state, p).join("\n");
  const frozen = {
    revision: effectiveRevision(p),
    setupNote: setupNoteContent(p, report),
    handover: { path: `.story/handovers/${ctx.today}-setup-${p.setupId.toLowerCase()}.md`, content: handoverContent(p, report) },
    historicalReport: report,
  };
  const payload = withReceipt({ ...p, frozen }, { step: "freeze", target: "frozen", ownedPre: null, ownedPost: digestOf(frozen), revision: frozen.revision });
  await commit(ctx, [], payload.receipts.at(-1)!, payload);
}

function frozenOf(p: SetupPayload) {
  if (!p.frozen) throw new SetupStop(3, "the finalization contents were never frozen");
  return p.frozen;
}

async function stepSetupNote(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const frozen = frozenOf(p);
  const existing = ctx.lr.state.notes.find((n) => {
    const meta = parseSetupMeta("note", n);
    return meta.kind === "record" && meta.meta.record === "final" && meta.meta.setupId === p.setupId;
  });
  if (existing) {
    throw ambiguity({ class: "corrupted receipt state", target: existing.id, observed: "a setup note with no receipt", expected: "no setup note before its receipt", resolutions: ["stop"] });
  }
  const { id, displayId } = await allocateNoteId(ctx.lr.state, ctx.root);
  const note = {
    id,
    ...(displayId !== undefined && { displayId }),
    title: `Setup ${p.setupId}`,
    content: frozen.setupNote,
    tags: ["setup"],
    status: "active",
    createdDate: ctx.today,
    updatedDate: ctx.today,
    setup: { setupId: p.setupId, record: "final" },
  } as Note;
  const op = await prepareNoteWrite(note, ctx.root);
  await commit(ctx, [op], { step: "setup-note", target: `note:${id}`, ownedPre: null, ownedPost: ownedDigest.bytes(frozen.setupNote), revision: frozen.revision });
  ctx.out.push(`-> storybloq · setup note ${displayId ?? id} created`);
}

/** The frozen handover path, held to `.story/handovers/` at the write boundary. */
async function handoverTarget(root: string, path: string): Promise<string> {
  const target = insideProject(root, path);
  const handovers = join(root, ".story", "handovers");
  if (dirname(target) !== handovers) {
    throw ambiguity({ class: "corrupted receipt state", target: path, observed: "a frozen handover path outside .story/handovers", expected: "a file in .story/handovers", resolutions: ["stop"] });
  }
  await guardPath(target, join(root, ".story"));
  return target;
}

async function stepHandover(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const frozen = frozenOf(p);
  await handoverTarget(ctx.root, frozen.handover.path);
  const outcome = await createUserFile(ctx.root, frozen.handover.path, frozen.handover.content, p.setupId, "user-owned target occupied");
  await setupApplySeams.fault("handover-created");
  await commit(ctx, [], { step: "handover", target: `file:${frozen.handover.path}`, ownedPre: null, ownedPost: ownedDigest.bytes(frozen.handover.content), revision: frozen.revision });
  ctx.out.push(`-> storybloq · handover ${posix.basename(frozen.handover.path)} ${outcome === "created" ? "created" : "already present"}`);
}

async function stepValidate(ctx: StepContext): Promise<void> {
  const frozen = frozenOf(ctx.progress.payload);
  const result = validateProject(ctx.lr.state);
  const errors = result.findings.filter((f) => f.level === "error");
  if (errors.length > 0) {
    throw new SetupStop(3, `validation found ${errors.length} error(s); fix them and resume`, errors.map((e) => `Validation error: ${e.message}`));
  }
  await commit(ctx, [], { step: "validate", target: "validation", ownedPre: null, ownedPost: digestOf(result.findings.map((f) => f.message)), revision: frozen.revision });
  ctx.out.push(`-> storybloq · validation clean (${result.findings.length} warnings or notes)`);
}

async function stepSnapshot(ctx: StepContext): Promise<void> {
  const frozen = frozenOf(ctx.progress.payload);
  const snap = await saveSnapshot(ctx.root, ctx.lr);
  await commit(ctx, [], { step: "snapshot", target: `snapshot:${snap.filename}`, ownedPre: null, ownedPost: sha256(snap.filename), revision: frozen.revision });
  ctx.out.push(`-> storybloq · snapshot ${snap.filename} saved`);
}

const FINALIZATION_STEPS = ["setup-note", "handover", "validate", "snapshot"];

/**
 * The revalidation gate and the archive, in one lock hold (plan v5 6a): the
 * revision is the frozen one, every finalization receipt is at it, the
 * artifacts are the frozen bytes, and only then is the progress note
 * archived, last.
 */
async function stepArchive(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const frozen = frozenOf(p);
  const fail = (why: string) => new SetupStop(3, `the finalization gate refused: ${why}`);
  if (effectiveRevision(p) !== frozen.revision) throw fail("the payload revision is not the frozen one");
  for (const step of FINALIZATION_STEPS) {
    const r = p.receipts.find((x) => x.step === step);
    if (!r || r.revision !== frozen.revision) throw fail(`${step} has no receipt at the frozen revision`);
  }
  const setupNote = ctx.lr.state.notes.find((n) => {
    const meta = parseSetupMeta("note", n);
    return meta.kind === "record" && meta.meta.record === "final" && meta.meta.setupId === p.setupId;
  });
  if (!setupNote || setupNote.content !== frozen.setupNote) throw fail("the setup note is not the frozen one");
  const handover = await readFile(await handoverTarget(ctx.root, frozen.handover.path), "utf-8").catch(() => null);
  if (handover !== frozen.handover.content) throw fail("the handover is not the frozen one");
  const payload = withReceipt(p, { step: "archive", target: `note:${ctx.progress.note.id}`, ownedPre: null, ownedPost: sha256("archived"), revision: frozen.revision });
  const note = await progressWrite(ctx.root, ctx.progress, payload, ctx.today, true);
  await setupApplySeams.fault("archive-gated");
  await runTransactionUnlocked(ctx.root, [{ op: "write", ...note }]);
  ctx.out.push(`-> storybloq · progress note ${ctx.progress.note.displayId ?? ctx.progress.note.id} archived`);
}

async function runSteps(root: string, setupId: string, out: string[], options: SetupApplyOptions): Promise<string> {
  let payload: SetupPayload | null = null;
  await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
    payload = readProgress(state, setupId).payload;
  });
  for (const step of planSteps(payload!)) {
    await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async (lr) => {
      const progress = readProgress(lr.state, setupId);
      if (hasReceipt(progress.payload, step.id)) return;
      await step.run({ root, lr, progress, today: localDateOf(new Date()), out });
    });
    await setupApplySeams.fault(`step:${step.id}`);
  }
  let report = "";
  await withProjectLock(root, { strict: false, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
    const archived = findProgress(state, setupId, "archived");
    report = archived.length > 0 ? parseSetupPayload(archived[0]!.content).frozen?.historicalReport ?? "" : "";
  });
  return report;
}

// --- Entry ------------------------------------------------------------------

const isLockBusy = (err: unknown) => err instanceof ProjectLoaderError && /Timed out acquiring project lock|legacy-format lock/.test(err.message);

/**
 * Applies an approved setup payload to `root`. Safe to call again with the
 * same payload after any interruption: it continues the setup from its
 * progress note, and after completion it returns the frozen report with
 * nothing written.
 */
export async function setupApply(root: string, raw: unknown, options: SetupApplyOptions = {}): Promise<SetupApplyResult> {
  const absRoot = resolve(root);
  let payload: SetupPayload;
  try {
    payload = validateSetupPayload(raw);
  } catch (err) {
    if (err instanceof SetupPayloadError) return { exitCode: 2, lines: [`Setup refused: ${err.message}`], setupId: null };
    throw err;
  }
  if (payload.receipts.length > 0 || payload.amendments.length > 0 || payload.preImages.length > 0 || payload.frozen !== null) {
    return { exitCode: 2, lines: ["Setup refused: a new setup payload carries no receipts, amendments, pre-images or frozen block; resume an existing setup instead."], setupId: payload.setupId };
  }
  const out: string[] = [];
  try {
    const wrap = join(absRoot, ".story");
    let start: Start = { kind: "run" };
    if (existsSync(join(wrap, "config.json")) || !(await bootstrap(absRoot, payload, out, options))) {
      if (existsSync(join(wrap, SETUP_BOOTSTRAP_MANIFEST))) await finishPublishedBootstrap(absRoot, payload, options);
      start = await startOnProject(absRoot, payload, out, options);
    }
    if (start.kind === "complete") {
      return { exitCode: 0, lines: [...start.report.split("\n"), `Setup applied: ${payload.setupId} (already complete; nothing written)`], setupId: payload.setupId };
    }
    const report = await runSteps(absRoot, payload.setupId, out, options);
    return { exitCode: 0, lines: [...out, ...report.split("\n"), `Setup applied: ${payload.setupId}`], setupId: payload.setupId };
  } catch (err) {
    if (err instanceof SetupStop) {
      const resume = err.exitCode === 2 ? "" : ` Resume with storybloq setup-apply --resume --setup ${payload.setupId}.`;
      return { exitCode: err.exitCode, lines: [...out, ...err.detail, `Setup stopped: ${err.reason}.${resume}`], setupId: payload.setupId };
    }
    if (isLockBusy(err)) {
      return { exitCode: 7, lines: [...out, "Setup stopped: the project lock is busy (another storybloq writer holds it); retry when it finishes."], setupId: payload.setupId };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 3, lines: [...out, `Setup stopped: ${message}. Resume with storybloq setup-apply --resume --setup ${payload.setupId}.`], setupId: payload.setupId };
  }
}
