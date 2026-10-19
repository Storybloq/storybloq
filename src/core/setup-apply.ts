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
import { z } from "zod";
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
  loadProject,
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
import { recordUserFileTarget } from "./board-write-recorder.js";
import { localDateOf } from "./local-date.js";
import { STORY_GITIGNORE_ENTRIES } from "./init.js";
import { allocateTeamIssueId, allocateTeamNoteId, nextIssueID, nextNoteID } from "./id-allocation.js";
import { reserveDisplayId } from "./remote-refs.js";
import { prepareNewTicketUnlocked } from "../cli/commands/ticket.js";
import { buildCheckpointTicketUnlocked, prepareCheckpointCreateWrite } from "./checkpoint-lifecycle.js";
import { enableCheckpointsStampUnlocked } from "./checkpoint-enable.js";
import { computeInitialStages, STAGES_USED, type PendingStageLine } from "./verification-activation.js";
import { resolveRecipe } from "../autonomous/recipes/loader.js";
import { validateProject } from "./validation.js";
import { saveSnapshot } from "./snapshot.js";
import { partitionByActionability, recommend, ticketCompletion } from "./recommend.js";
import { checkpointReady, checkpointState, hasOwnerCheckpoint, parseOwnerCheckpoint } from "./owner-checkpoint.js";
import { describeCheckpointBlock, prepareCompletionWrite } from "./checkpoint-evidence.js";
import { authoriseStatusChange, collectCompletionOwnership, CompletionOwnershipUnavailable } from "./status-authority.js";
import { hasClaimMaterial, type CompletionGuardOptions } from "./claims.js";
import { parseSetupMeta, type VerificationSpec } from "./setup-meta.js";
import { ESTABLISHMENT_CREATION_AUTHORITY, isEstablishment } from "./setup-verification-guard.js";
import { initialRecord, readRecord } from "./setup-verification-record.js";
import { displayIdOf } from "./resolver.js";
import { classify as classifyReview, digest12, loadRecords, readSetup, setupPaths, SETUP_ID_PATTERN } from "./setup-review.js";
import {
  parseSetupPayload,
  plannedStatus,
  renderSetupPayload,
  usesEstablishment,
  SetupPayloadError,
  validateSetupPayload,
  type SetupPayload,
  readinessEndpoint,
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
  /** Where the setup-review store is found, for a material amendment's review (default process.env). */
  readonly env?: NodeJS.ProcessEnv;
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
export function approvedPayload(p: SetupPayload): Omit<SetupPayload, "receipts" | "amendments" | "preImages" | "frozen" | "frozenHistory"> {
  const { receipts: _r, amendments: _a, preImages: _p, frozen: _f, frozenHistory: _h, ...approved } = p;
  return approved;
}

/** The revision finalization is bound to: the approved package plus its ordered amendments (plan v5 6a). */
export function effectiveRevision(p: SetupPayload): string {
  return digestOf({ approved: approvedPayload(p), amendments: p.amendments });
}

/**
 * The part of a ticket's `setup` field setup owns. An establishment ticket
 * (T-538 S3a-2) opts in to a projection: its key, what it establishes and its
 * verification spec, never what setup-verify records later (result, decision,
 * reopenings). Any other value is hashed as it is, as before.
 */
function ownedSetup(setup: unknown): unknown {
  if (typeof setup !== "object" || setup === null || Array.isArray(setup)) return setup ?? null;
  const s = setup as Record<string, unknown>;
  if (!("establishes" in s) && !("verification" in s)) return setup;
  const v = s.verification;
  const spec = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>).spec : undefined;
  return { setupId: s.setupId, key: s.key, ...("supersededBy" in s && { supersededBy: s.supersededBy }), establishes: s.establishes, spec };
}

/** How long one setup-verify run may take, from spawn until its process group is gone. */
export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a VERIFY server may take to answer its readiness check, and to be gone after its shutdown starts. */
export const VERIFY_STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
export const VERIFY_SHUTDOWN_TIMEOUT_MS = 10 * 1000;

/** The verification spec an establishment ticket is created with: its component's stage as the payload names it. */
export function verificationSpec(p: SetupPayload, t: SetupPayload["tickets"][number]): VerificationSpec | null {
  if (t.establishes === undefined) return null;
  const comp = p.quality.components.find((c) => c.id === t.establishes!.component)!;
  const base = { setupId: p.setupId, component: comp.id, workdir: comp.workdir };
  switch (t.establishes.stage) {
    case "test": {
      const test = comp.test!;
      return { ...base, stage: "test", command: test.command, runner: test.runner!, wrapper: test.wrapper!, timeoutMs: VERIFICATION_TIMEOUT_MS };
    }
    case "build":
      return { ...base, stage: "build", command: comp.build!.command, timeoutMs: VERIFICATION_TIMEOUT_MS };
    case "verify": {
      const at = readinessEndpoint(comp.verify!.readinessUrl)!;
      return { ...base, stage: "verify", command: comp.verify!.startCommand, host: "127.0.0.1", port: at.port, readinessPath: at.path, startupTimeoutMs: VERIFY_STARTUP_TIMEOUT_MS, shutdownTimeoutMs: VERIFY_SHUTDOWN_TIMEOUT_MS };
    }
  }
}

/** The setup field setup writes on a planned ticket. */
function plannedSetupField(p: SetupPayload, t: SetupPayload["tickets"][number]): Record<string, unknown> {
  const spec = verificationSpec(p, t);
  return { setupId: p.setupId, key: t.key, ...(spec !== null && { establishes: t.establishes, verification: { spec } }) };
}

/** Setup-owned fields per entity (plan v5 1d); the digest a receipt records. */
export const ownedDigest = {
  phase: (phase: { id: string; name: string; label: string; description: string }, position: number) =>
    digestOf({ id: phase.id, name: phase.name, label: phase.label, description: phase.description, position }),
  /**
   * `planned` opts in (T-538 S3a-1): a planned ticket with an explicit status
   * owns its status and completion date too. Without one the hashed object is
   * exactly the legacy one, so every earlier receipt still matches.
   */
  ticket: (t: Ticket, planned?: { status?: "open" | "complete" }) => {
    const raw = t as Ticket & { setup?: unknown; ownerCheckpoint?: { digest?: string } };
    const owned = { title: t.title, type: t.type, phase: t.phase, description: t.description, setup: ownedSetup(raw.setup), checkpoint: raw.ownerCheckpoint?.digest ?? null };
    return digestOf(planned?.status === undefined ? owned : { ...owned, status: t.status, completedDate: t.completedDate ?? null });
  },
  issue: (i: Issue) => digestOf({ title: i.title, impact: i.impact, components: i.components, setup: (i as Issue & { setup?: unknown }).setup ?? null }),
  /** The verification record (T-538 S3a-2) is owned only where a setup wrote one; a config without it hashes as before. */
  config: (c: Config) => {
    const stages = (c as Config & { recipeOverrides?: { stages?: unknown } }).recipeOverrides?.stages ?? null;
    const record = Object.hasOwn(c, "setupVerification") ? { setupVerification: (c as Config & { setupVerification?: unknown }).setupVerification } : {};
    return digestOf({ project: c.project, type: c.type, language: c.language, stages, ...record });
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

type Receipt = SetupPayload["receipts"][number];

/** The receipt that decides a step's state: its last one (an accepted amendment appends a new baseline). */
function lastReceipt(p: SetupPayload, step: string): Receipt | undefined {
  for (let i = p.receipts.length - 1; i >= 0; i--) if (p.receipts[i]!.step === step) return p.receipts[i];
  return undefined;
}

/** Finalization steps whose receipt counts only at the current frozen revision (plan v5 6a). */
const REVISIONED_STEPS = new Set(["setup-note", "handover", "validate", "snapshot"]);

function stepDone(p: SetupPayload, step: string): boolean {
  const current = p.frozen !== null && p.frozen.revision === effectiveRevision(p);
  if (step === "freeze") return current && hasReceipt(p, "freeze");
  if (REVISIONED_STEPS.has(step)) return current && lastReceipt(p, step)?.revision === p.frozen!.revision;
  return hasReceipt(p, step);
}

export const DROPPED_CHECKPOINTS_DEFERRAL = "its checkpoints were dropped (schema-5 enable refused)";

/**
 * The approved plan with its amendments applied: a dropped checkpoint set
 * leaves the plan, and so do its gates, every dependency on a dropped key and
 * every coverage reference to one (review r1 #3); a requirement left mapping
 * to nothing records why.
 */
export function effectivePlan(p: SetupPayload): SetupPayload {
  const dropped = p.amendments.some((a) => a.class === "schema-5 enable refused" && a.resolution === "drop-checkpoints");
  if (!dropped) return p;
  const gone = new Set(p.checkpoints.map((c) => c.key));
  return {
    ...p,
    checkpoints: [],
    tickets: p.tickets.map((t) => ({ ...t, blockedBy: t.blockedBy.filter((k) => !gone.has(k)) })),
    coverage: p.coverage.map((c) => {
      const keys = c.keys.filter((k) => !gone.has(k));
      if (keys.length === c.keys.length) return c;
      return keys.length > 0 ? { ...c, keys } : { ...c, keys, deferral: c.deferral ?? DROPPED_CHECKPOINTS_DEFERRAL };
    }),
  };
}

/** The frozen block a receipt's revision names, current or superseded. */
function frozenAt(p: SetupPayload, revision: string | undefined): NonNullable<SetupPayload["frozen"]> | undefined {
  return [...(p.frozen ? [p.frozen] : []), ...p.frozenHistory].find((f) => f.revision === revision);
}

/** The handover of the current revision (plan v5 12.3): selected by receipt revision, never by digest order. */
export function setupHandoverPath(p: SetupPayload): string | null {
  const revision = effectiveRevision(p);
  const r = [...p.receipts].reverse().find((x) => x.step === "handover" && x.revision === revision);
  return r ? r.target.slice("file:".length) : null;
}

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
 * Resolved containment before a write (review r1 #1): the loader writers'
 * guardPath, on the deepest existing ancestor, so a directory that is a
 * symlink out of the project never carries a mkdir, create or `.proposed`.
 * Only the preflight, before setup writes anything, refuses at exit 2; once
 * setup has started it is a resumable stop at exit 4 (review r2 #4).
 */
async function guardWrite(root: string, target: string, path: string, preflight = false): Promise<void> {
  try {
    await guardPath(target, root);
  } catch (err) {
    if (!(err instanceof ProjectLoaderError)) throw err;
    if (preflight) throw new SetupStop(2, `the path ${path} resolves outside the project`);
    throw ambiguity({ class: "path outside the project", target: path, observed: "a directory on the path resolves outside the project", expected: "the path inside the project; move the directory back, then resume", resolutions: ["stop"] });
  }
}

/** A payload path inside the project both lexically and once resolved. */
async function containedTarget(root: string, path: string, preflight = false): Promise<string> {
  const target = insideProject(root, path);
  await guardWrite(root, target, path, preflight);
  return target;
}

/** The `.proposed` copy is setup's only durable version until its step is receipted (1f); after that it goes. */
async function removeProposed(target: string, setupId: string): Promise<void> {
  try {
    await fencedUnlink(proposedPath(target, setupId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * A user-owned file (plan v5 1f): created, never replaced. Absent: created.
 * Present with the same bytes: done. Present with other bytes: setup's
 * version is left beside it as `.proposed` and the run stops for the owner.
 */
async function createUserFile(root: string, path: string, content: string, setupId: string, klass: string): Promise<"created" | "present"> {
  const target = await containedTarget(root, path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await atomicCreate(target, content);
    recordUserFileTarget(target);
    return "created";
  } catch (err) {
    if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
  }
  const current = await readFile(target, "utf-8");
  if (current === content) return "present";
  await guardWrite(root, proposedPath(target, setupId), path);
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

/** An archived progress note is a completed setup only when its archive step is receipted; otherwise the owner set it aside. */
function completedSetup(archived: readonly Note[]): Start {
  const done = archived.map((n) => parseSetupPayload(n.content)).find((x) => hasReceipt(x, "archive"));
  if (!done) throw new SetupStop(2, `setup ${parseSetupPayload(archived[0]!.content).setupId} was set aside: its progress note was archived before it finished`);
  return { kind: "complete", report: done.frozen?.historicalReport ?? "" };
}

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
      start = completedSetup(archived);
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
  /** Runs instead when the step is already receipted: what a crash between its receipt and its cleanup left. */
  readonly tidy?: (ctx: StepContext) => Promise<void>;
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
  for (const ptr of p.governance.pointers ?? []) {
    steps.push({ id: `pointer:${ptr.path}`, run: (ctx) => stepPointer(ctx, ptr), tidy: (ctx) => tidyPointer(ctx.root, ptr.path, ctx.progress.payload, ctx.out) });
  }
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
      expected: `schema ${IMMUTABLE_EVIDENCE_SCHEMA_VERSION}: run storybloq checkpoint enable --immutable-evidence and resume, or drop the checkpoints`,
      resolutions: ["drop-checkpoints", "stop"],
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
  // Already-built work is created complete, dated the day the setup began (stable across resumes and restores).
  const done = plannedStatus(t) === "complete" ? { status: "complete" as const, completedDate: ctx.progress.note.createdDate } : {};
  const ticket = { ...base, ...done, setup: plannedSetupField(p, t) } as Ticket;
  const op = await prepareTicketWrite(ticket, ctx.root, t.establishes !== undefined ? { verificationAuthority: ESTABLISHMENT_CREATION_AUTHORITY } : undefined);
  await commit(ctx, [op], { step: `item:${key}`, target: `ticket:${ticket.id}`, ownedPre: null, ownedPost: ownedDigest.ticket(ticket, t) });
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
  const issue = {
    id,
    ...(displayId !== undefined && { displayId }),
    title: i.title,
    status: "open",
    severity: "medium",
    components: i.labels,
    impact: plannedImpact(i),
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
  // The prospective graph, checked in the same hold before the write and its receipt.
  const cycle = edgeCycle((id) => state.ticketByID(id)?.blockedBy ?? [], item.id, blockedBy);
  if (cycle) throw cycleStop(key, cycle);
  const op = await prepareTicketWrite({ ...item, blockedBy } as Ticket, ctx.root);
  await commit(ctx, [op], { step: `wire:${key}`, target: `ticket:${item.id}`, ownedPre: ownedDigest.edges([]), ownedPost: ownedDigest.edges(setupEdges), edges: setupEdges.map((b): [string, string] => [item.id, b]) });
  ctx.out.push(`-> storybloq · ${item.displayId ?? item.id} wired: blocked by ${blockers.map((b) => b!.displayId ?? b!.id).join(", ")}`);
}

/**
 * The blockedBy cycle `id` would close once its edges are `blockedBy`, as a
 * path from `id` back to it, or null (review r1 #4). Only `id`'s edges change,
 * so any new cycle runs through it.
 */
function edgeCycle(blockedByOf: (id: string) => readonly string[], id: string, blockedBy: readonly string[]): string[] | null {
  const next = (t: string) => (t === id ? blockedBy : blockedByOf(t));
  const seen = new Set<string>();
  const walk = (t: string, path: string[]): string[] | null => {
    if (t === id) return path;
    if (seen.has(t)) return null;
    seen.add(t);
    for (const b of next(t)) {
      const found = walk(b, [...path, b]);
      if (found) return found;
    }
    return null;
  };
  for (const b of blockedBy) {
    const found = walk(b, [id, b]);
    if (found) return found;
  }
  return null;
}

function cycleStop(target: string, cycle: readonly string[]): SetupStop {
  return ambiguity({ class: "dependency cycle", target, observed: cycle.join(" -> "), expected: "no item that blocks itself; remove one of these edges, then resume", resolutions: ["stop"] });
}

function activationInput(p: SetupPayload) {
  return { level: p.quality.level, verifyApplies: p.quality.verifyApplies, components: p.quality.components };
}

const PROJECT_FACTS = ["project", "type", "language"] as const;
type ProjectFact = (typeof PROJECT_FACTS)[number];
/**
 * The defaults init writes when nobody stated a type or language
 * (src/core/init.ts, `options.type ?? "generic"` and `options.language ??
 * "unknown"`). Exactly these two values count as unstated, so a scaffold
 * holding one takes the package's value; any other non-empty value is kept.
 */
const INIT_PLACEHOLDER: Partial<Record<ProjectFact, string>> = { type: "generic", language: "unknown" };
const proposedFact = (p: SetupPayload, f: ProjectFact): string => (f === "project" ? p.project.name : p.project[f]);
const stagesOf = (c: Config): Record<string, unknown> => ((c as Config & { recipeOverrides?: { stages?: Record<string, unknown> } }).recipeOverrides?.stages) ?? {};

/** The stages a session would run with: the project's recipe merged with its overrides, as the guide resolves them. */
function effectiveStages(c: Config): Readonly<Record<string, Record<string, unknown>>> {
  const recipe = (c as Config & { recipe?: unknown }).recipe;
  const overrides = stagesOf(c);
  const stages = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? (overrides as Record<string, Record<string, unknown>>) : {};
  try {
    return resolveRecipe(typeof recipe === "string" ? recipe : "coding", { stages }).stages;
  } catch {
    // A recipe the guide itself would refuse; the report still reads the overrides as written.
    return stages;
  }
}

/** The reused scaffold's config as setup recorded it before its first change, or null on a fresh folder. */
function scaffoldConfig(p: SetupPayload): Config | null {
  const pre = p.preImages.find((x) => x.target === ".story/config.json");
  return pre ? (JSON.parse(pre.content) as Config) : null;
}

/**
 * The config with setup's owned values written over it (plan v5 5b): the
 * matrix's stages, and the project facts only where the scaffold stated none
 * (review r1 #2: a reused scaffold keeps its own project, type and language).
 */
function plannedConfig(p: SetupPayload, config: Config): Config {
  const { stages } = computeInitialStages(activationInput(p));
  const overrides = (config as Config & { recipeOverrides?: Record<string, unknown> }).recipeOverrides ?? {};
  const scaffold = scaffoldConfig(p);
  const facts = Object.fromEntries(PROJECT_FACTS.map((f) => {
    const own = scaffold?.[f];
    return [f, typeof own === "string" && own.trim() !== "" && own !== INIT_PLACEHOLDER[f] ? own : proposedFact(p, f)];
  }));
  // A setup that establishes a test stage writes its verification record with the stages (T-538 S3a-2).
  const record = usesEstablishment(p) ? { setupVerification: initialRecord(p) } : {};
  return { ...config, ...facts, recipeOverrides: { ...overrides, stages: { ...stagesOf(config), ...stages } }, ...record } as Config;
}

/**
 * After the owner accepted the scaffold config as it stood (accept-current on
 * a pre-image drift), what they changed from the pre-image is what the config
 * step writes; the rest is planned (review r1 #2).
 */
function withAccepted(p: SetupPayload, config: Config, planned: Config): Config {
  const scaffold = scaffoldConfig(p);
  if (scaffold === null || !lastReceipt(p, "config-baseline")) return planned;
  const next = { ...planned } as Config & Record<string, unknown>;
  for (const f of PROJECT_FACTS) if (config[f] !== scaffold[f]) next[f] = config[f];
  const now = stagesOf(config);
  const was = stagesOf(scaffold);
  const stages = { ...stagesOf(planned) };
  for (const name of new Set([...Object.keys(now), ...Object.keys(was)])) {
    if (digestOf(now[name] ?? null) === digestOf(was[name] ?? null)) continue;
    if (now[name] === undefined) delete stages[name];
    else stages[name] = now[name];
  }
  const overrides = (planned as Config & { recipeOverrides?: Record<string, unknown> }).recipeOverrides ?? {};
  return { ...next, recipeOverrides: { ...overrides, stages } } as Config;
}

/** Whether a config turns any recipe stage on or off differently from the approved quality level. */
function stagesDiffer(p: SetupPayload, config: Config): boolean {
  const { stages } = computeInitialStages(activationInput(p));
  const current = ((config as Config & { recipeOverrides?: { stages?: Record<string, { enabled?: unknown }> } }).recipeOverrides?.stages) ?? {};
  return Object.entries(stages).some(([name, s]) => current[name]?.enabled !== s.enabled);
}

async function stepConfig(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const config = ctx.lr.state.config;
  const { stages } = computeInitialStages(activationInput(p));
  const next = withAccepted(p, config, plannedConfig(p, config));
  const op = await prepareConfigWrite(next, ctx.root);
  await commit(ctx, [op], { step: "config", target: "config", ownedPre: ownedDigest.config(config), ownedPost: ownedDigest.config(next) });
  invalidateResolutionWriteContext(ctx.root);
  const written = stagesOf(next) as Record<string, { enabled?: unknown } | undefined>;
  const on = Object.keys(stages).filter((name) => written[name]?.enabled === true);
  ctx.out.push(`-> storybloq · recipe stages written (${p.quality.level}; on: ${on.length > 0 ? on.join(", ") : "none"})`);
}

async function stepGovernance(ctx: StepContext, path: string, content: string): Promise<void> {
  const p = ctx.progress.payload;
  const outcome = await createUserFile(ctx.root, path, content, p.setupId, "user-owned target occupied");
  await setupApplySeams.fault(`governance-created:${posix.normalize(path)}`);
  await commit(ctx, [], { step: `governance:${posix.normalize(path)}`, target: `file:${posix.normalize(path)}`, ownedPre: null, ownedPost: ownedDigest.bytes(content) });
  await removeProposed(insideProject(ctx.root, path), p.setupId);
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
    await guardWrite(ctx.root, proposedPath(target, p.setupId), ".gitignore");
    try {
      await atomicCreate(proposedPath(target, p.setupId), proposed);
    } catch (err) {
      if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
    }
    throw ambiguity({ class: "pointer edit owed", target: ".gitignore", observed: `missing ${missing.join(", ")}`, expected: `the entries in .gitignore.storybloq-${p.setupId}.proposed`, resolutions: ["applied", "keep-current", "stop"] });
  }
  await commit(ctx, [], { step: "gitignore", target: "file:.gitignore", ownedPre: null, ownedPost: digestOf([...wanted].sort()) });
  await removeProposed(target, p.setupId);
  ctx.out.push("-> git · .gitignore already lists the setup entries");
}

// --- Entry-file pointers (T-538 S3b) -----------------------------------------

type PointerPlan = NonNullable<SetupPayload["governance"]["pointers"]>[number];

/** The proposal beside an entry file, relative to the project. */
const pointerProposal = (path: string, setupId: string) => `${path}.storybloq-${setupId}.proposed`;

/** The entry file with the setup's block after a blank line. */
function withPointerBlock(current: string, block: string): string {
  return current === "" ? block : `${current}${current.endsWith("\n") ? "\n" : "\n\n"}${block}`;
}

/**
 * A pointer step: the engine never writes the entry file. The block already
 * there byte for byte is receipted `applied`. Otherwise an intent receipt
 * (the entry file's sha256 and the proposal's) is committed before the
 * proposal is created beside the file, and the run stops for the owner.
 */
async function stepPointer(ctx: StepContext, ptr: PointerPlan): Promise<void> {
  const p = ctx.progress.payload;
  const current = await readOrNull(join(ctx.root, ptr.path));
  if (current !== null && current.includes(ptr.block)) {
    const payload = withReceipt(p, { step: `pointer:${ptr.path}`, target: `file:${ptr.path}`, ownedPre: null, ownedPost: sha256(ptr.block), outcome: "applied" });
    await commit(ctx, [], payload.receipts.at(-1)!, payload);
    await setupApplySeams.fault(`pointer-receipted:${ptr.path}`);
    await tidyPointer(ctx.root, ptr.path, payload, ctx.out);
    ctx.out.push(`-> file · ${ptr.path} carries setup's pointer block`);
    return;
  }
  const intent: Receipt = {
    step: `pointer-proposal:${ptr.path}`,
    target: `file:${pointerProposal(ptr.path, p.setupId)}`,
    ownedPre: current === null ? ABSENT : sha256(current),
    ownedPost: sha256(withPointerBlock(current ?? "", ptr.block)),
  };
  const payload = withReceipt(p, intent);
  await commit(ctx, [], intent, payload);
  await setupApplySeams.fault(`pointer-intent:${ptr.path}`);
  const finding = await pointerFinding(ctx.root, payload, ptr);
  await setupApplySeams.fault(`pointer-proposed:${ptr.path}`);
  throw ambiguities([finding!]);
}

/**
 * A pointer's proposal against its intent receipt: one already there with
 * the intended bytes is adopted; a missing one is created when the entry
 * file is still what the intent recorded (`stale` otherwise, nothing
 * created); any other bytes are a conflict, never adopted or removed.
 */
async function ensureProposal(root: string, p: SetupPayload, ptr: PointerPlan): Promise<"ours" | "stale" | "conflict"> {
  const intent = lastReceipt(p, `pointer-proposal:${ptr.path}`)!;
  const rel = pointerProposal(ptr.path, p.setupId);
  const target = join(root, rel);
  const existing = await readOrNull(target);
  if (existing !== null) return sha256(existing) === intent.ownedPost ? "ours" : "conflict";
  const content = withPointerBlock((await readOrNull(join(root, ptr.path))) ?? "", ptr.block);
  if (sha256(content) !== intent.ownedPost) return "stale";
  await guardWrite(root, target, rel);
  try {
    await atomicCreate(target, content);
  } catch (err) {
    if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
    return sha256((await readOrNull(target)) ?? "") === intent.ownedPost ? "ours" : "conflict";
  }
  return "ours";
}

/** What a pointer owes the owner now, or null: drift of an applied block, a conflicting proposal, or the edit itself. */
async function pointerFinding(root: string, p: SetupPayload, ptr: PointerPlan): Promise<Finding | null> {
  const current = await readOrNull(join(root, ptr.path));
  const has = current !== null && current.includes(ptr.block);
  const ref = { path: ptr.path };
  const r = lastReceipt(p, `pointer:${ptr.path}`);
  if (r) {
    // A waived pointer is the owner's file as it is; only an applied block can drift.
    if (r.outcome !== "applied" || has) return null;
    return {
      kind: "pointer-drift", class: "governance file drifted", target: ptr.path,
      observed: current === null ? "the file is gone" : "setup's pointer block is no longer in it", expected: "the pointer block the owner applied",
      resolutions: ["keep-current", "stop"], ref,
    };
  }
  if (has || lastReceipt(p, `pointer-proposal:${ptr.path}`) === undefined) return null;
  const rel = pointerProposal(ptr.path, p.setupId);
  const proposal = await ensureProposal(root, p, ptr);
  if (proposal === "conflict") {
    return {
      kind: "proposal-conflict", class: "proposal conflict", target: ptr.path,
      observed: `${rel} holds bytes setup did not write`, expected: "setup's proposal or none; the file is left as it is",
      resolutions: ["keep-current", "stop"], ref,
    };
  }
  return {
    kind: "entry-pointer", class: "pointer edit owed", target: ptr.path,
    observed: current === null ? "the file is gone" : "setup's pointer block is not in it",
    expected: proposal === "ours" ? `the block in ${posix.basename(rel)}` : `setup's pointer block (${ptr.path} changed since its proposal was recorded)`,
    resolutions: ["applied", "keep-current", "stop"], ref,
  };
}

/** Removes a pointer's proposal only while it holds the bytes its intent recorded; a changed one stays, and the output says so. */
async function tidyPointer(root: string, path: string, p: SetupPayload, out: string[]): Promise<void> {
  const intent = lastReceipt(p, `pointer-proposal:${path}`);
  const rel = pointerProposal(path, p.setupId);
  const current = await readOrNull(join(root, rel));
  if (current === null) return;
  if (intent === undefined || sha256(current) !== intent.ownedPost) {
    out.push(`-> file · ${rel} is not setup's proposal; left as it is`);
    return;
  }
  try {
    await fencedUnlink(join(root, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// --- Resume classification (plan v5 1d, 2) ----------------------------------

/** Digest of a user-owned file that is gone, and of a step the owner kept as it is. */
const ABSENT = sha256("\u0000absent");
const KEPT = sha256("\u0000kept-current");

type FindingKind =
  | "edited" | "removed" | "duplicate" | "unkeyed" | "edge" | "config" | "config-pre"
  | "governance-drift" | "occupied" | "gitignore-drift" | "pointer" | "enable" | "progress" | "stop-only"
  | "entry-pointer" | "pointer-drift" | "proposal-conflict";

/** One ambiguity plus what `--resolve` needs to act on it. */
interface Finding extends SetupAmbiguity {
  readonly kind: FindingKind;
  readonly ref: Readonly<Record<string, string>>;
}

export function allKeyed(state: ProjectState, setupId: string, key: string): Array<Ticket | Issue> {
  const mine = (kind: "ticket" | "issue") => (x: Ticket | Issue) => {
    const meta = parseSetupMeta(kind, x);
    return meta.kind === "item" && meta.meta.setupId === setupId && meta.meta.key === key && meta.meta.supersededBy === undefined;
  };
  return [...state.tickets.filter(mine("ticket")), ...state.issues.filter(mine("issue"))];
}

function plannedImpact(i: SetupPayload["issues"][number]): string {
  const impact = i.source === null ? i.body : `${i.body}${i.body === "" ? "" : "\n\n"}Imported from GitHub issue #${i.source}.`;
  return impact === "" ? i.title : impact;
}

type PlannedItem =
  | { readonly kind: "ticket"; readonly item: SetupPayload["tickets"][number] }
  | { readonly kind: "checkpoint"; readonly item: SetupPayload["checkpoints"][number] }
  | { readonly kind: "issue"; readonly item: SetupPayload["issues"][number] };

function plannedItems(plan: SetupPayload): PlannedItem[] {
  return [
    ...plan.tickets.map((item): PlannedItem => ({ kind: "ticket", item })),
    ...plan.checkpoints.map((item): PlannedItem => ({ kind: "checkpoint", item })),
    ...plan.issues.map((item): PlannedItem => ({ kind: "issue", item })),
  ];
}

/** The owned fields of an item that differ from the plan, by name. */
function itemDrift(plan: SetupPayload, planned: PlannedItem, current: Ticket | Issue): string[] {
  if (planned.kind === "issue") {
    const i = current as Issue;
    return [
      i.title !== planned.item.title ? "title" : null,
      i.impact !== plannedImpact(planned.item) ? "impact" : null,
      JSON.stringify(i.components) !== JSON.stringify(planned.item.labels) ? "components" : null,
    ].filter((x): x is string => x !== null);
  }
  const t = current as Ticket;
  const type = planned.kind === "checkpoint" ? t.type : planned.item.type;
  return [
    t.title !== planned.item.title ? "title" : null,
    t.type !== type ? "type" : null,
    t.phase !== phaseIdOf(plan, planned.item.phase) ? "phase" : null,
    t.description !== planned.item.description ? "description" : null,
    ...(planned.kind === "ticket" && planned.item.status !== undefined ? [t.status !== planned.item.status ? "status" : null] : []),
  ].filter((x): x is string => x !== null);
}

/** The planned ticket whose explicit status the owned digest covers; checkpoints and issues never carry one. */
function plannedOf(planned: PlannedItem): { status?: "open" | "complete" } | undefined {
  return planned.kind === "ticket" ? planned.item : undefined;
}

/** The day the setup began: its progress note's creation date, which no resume or restore changes. */
function setupDate(state: ProjectState, setupId: string): string {
  const note = findProgress(state, setupId, "active")[0] ?? findProgress(state, setupId, "archived")[0];
  return note!.createdDate;
}

const label = (x: { id: string; displayId?: string }) => x.displayId ?? x.id;

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function leaveProposed(root: string, target: string, path: string, setupId: string, content: string): Promise<void> {
  await guardWrite(root, proposedPath(target, setupId), path);
  try {
    await atomicCreate(proposedPath(target, setupId), content);
  } catch (err) {
    if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
  }
}

function missingEntries(current: string | null, wanted: readonly string[]): string[] {
  const lines = new Set((current ?? "").split(/\r?\n/).map((l) => l.trim()));
  return wanted.filter((w) => !lines.has(w));
}

/**
 * Every entity setup has written or is about to write, against its permitted
 * cumulative states (plan v5 1d): its last receipt's owned digest, or, before
 * its first receipt, absent. Runs under the lock in every step's hold, so
 * each step's write is a compare-and-set against the state classified here.
 * The only writes are `.proposed` copies beside user-owned files (1f).
 */
async function classifySetup(root: string, state: ProjectState, p: SetupPayload): Promise<Finding[]> {
  const plan = effectivePlan(p);
  const out: Finding[] = [];
  const stopOnly = (klass: string, target: string, observed: string, expected: string): Finding =>
    ({ kind: "stop-only", class: klass, target, observed, expected, resolutions: ["stop"], ref: {} });

  const duplicated = new Set<string>();
  for (const { item } of plannedItems(plan)) {
    const items = allKeyed(state, p.setupId, item.key);
    if (items.length < 2) continue;
    duplicated.add(item.key);
    out.push({
      kind: "duplicate", class: "key on two items", target: `${item.key} (${items.map(label).join(", ")})`,
      observed: `${items.length} items carry ${item.key}`, expected: "one item per key",
      resolutions: [...items.map((x) => `keep ${x.id}`), "stop"], ref: { key: item.key },
    });
  }

  for (const ph of plan.phases) {
    const r = lastReceipt(p, `phase:${ph.key}`);
    if (!r) continue;
    const target = `phase ${ph.id} (${ph.key})`;
    const at = state.roadmap.phases.findIndex((x) => x.id === ph.id);
    if (at < 0) {
      out.push(stopOnly("setup item removed", target, "no phase with this id", "the phase setup created"));
      continue;
    }
    const current = state.roadmap.phases[at]!;
    if (ownedDigest.phase({ ...current, description: current.description ?? "" }, at) === r.ownedPost) continue;
    const fields = (["name", "label", "description"] as const).filter((f) => (current[f] ?? "") !== ph[f]);
    out.push({
      kind: "edited", class: "owned field edited", target,
      observed: fields.length > 0 ? `${fields.join(", ")} differ from the plan` : "the position or values differ from the accepted baseline",
      expected: "the values setup wrote", resolutions: ["accept-current", "restore-planned", "stop"],
      ref: { entity: "phase", key: ph.key, step: `phase:${ph.key}` },
    });
  }

  for (const planned of plannedItems(plan)) {
    const key = planned.item.key;
    if (duplicated.has(key)) continue;
    const r = lastReceipt(p, `item:${key}`);
    const [item] = allKeyed(state, p.setupId, key);
    if (!r) {
      if (item) {
        out.push(stopOnly("corrupted receipt state", `${key} (${item.id})`, `an item carrying ${key} with no receipt`, "no item before its create receipt"));
        continue;
      }
      if (p.amendments.some((a) => a.resolution === "replace" && a.target.startsWith(`${key} `))) continue;
      const pool: Array<Ticket | Issue> = planned.kind === "issue"
        ? [...state.issues]
        : state.tickets.filter((t) => ((t as Ticket & { ownerCheckpoint?: unknown }).ownerCheckpoint !== undefined) === (planned.kind === "checkpoint"));
      const matches = pool.filter((x) => x.title === planned.item.title && parseSetupMeta(planned.kind === "issue" ? "issue" : "ticket", x).kind === "none");
      if (matches.length > 0) {
        // An establishment ticket is never adopted: an adopted ticket has no verification spec (T-538 S3a-2).
        const establishing = planned.kind === "ticket" && planned.item.establishes !== undefined;
        out.push({
          kind: "unkeyed", class: "unkeyed item matches a planned item", target: `${key} (${matches.map(label).join(", ")})`,
          observed: `an item titled "${planned.item.title}" that no setup owns`, expected: `setup to create ${key}`,
          resolutions: [...(establishing ? [] : matches.map((x) => `adopt ${x.id}`)), "replace", "stop"], ref: { key, kind: planned.kind },
        });
      }
      continue;
    }
    const target = `${key} (${r.target.slice(r.target.indexOf(":") + 1)})`;
    if (!item) {
      out.push(stopOnly("setup item removed", target, `no item carries ${key}`, "the item setup created"));
      continue;
    }
    const digest = planned.kind === "issue" ? ownedDigest.issue(item as Issue) : ownedDigest.ticket(item as Ticket, plannedOf(planned));
    if (digest === r.ownedPost) continue;
    const fields = itemDrift(plan, planned, item);
    // An establishment's key, what it establishes and its spec are fixed at creation; no resolution rewrites them (T-538 S3a-2).
    const setupDrift = planned.kind === "ticket" && planned.item.establishes !== undefined
      && serializeJSON(ownedSetup((item as Ticket & { setup?: unknown }).setup)) !== serializeJSON(ownedSetup(plannedSetupField(plan, planned.item)));
    if (setupDrift) {
      out.push(stopOnly("owned field edited", `${key} (${label(item)})`, "its establishes or verification spec differ from what setup wrote", "the values setup wrote; put them back by hand, then resume"));
      continue;
    }
    // Restoring the planned fields of a checkpoint must reach its create receipt: otherwise its own content changed.
    const contentChanged = planned.kind === "checkpoint"
      && ownedDigest.ticket(restoredTicket(plan, planned, item as Ticket, setupDate(state, p.setupId))) !== p.receipts.find((x) => x.step === `item:${key}`)!.ownedPost;
    out.push({
      kind: "edited", class: "owned field edited", target: `${key} (${label(item)})`,
      observed: fields.length > 0 ? `${fields.join(", ")} differ from the plan` : "the values differ from the accepted baseline",
      expected: "the values setup wrote",
      // A checkpoint's own content changes only through the checkpoint commands, never by restoring it here.
      resolutions: contentChanged ? ["accept-current", "stop"] : ["accept-current", "restore-planned", "stop"],
      ref: { entity: planned.kind, key, step: `item:${key}`, id: item.id },
    });
  }

  for (const [key] of setupBlockers(plan)) {
    const r = lastReceipt(p, `wire:${key}`);
    for (const [itemId, blockerId] of r?.edges ?? []) {
      const t = state.ticketByID(itemId);
      if (!t || t.blockedBy.includes(blockerId)) continue;
      out.push({
        kind: "edge", class: "setup edge removed", target: `${label(t)} -> ${blockerId}`,
        observed: `${label(t)} is no longer blocked by ${blockerId}`, expected: "the edge setup wired",
        resolutions: ["accept-removal", "restore-edge", "stop"], ref: { key, item: itemId, blocker: blockerId },
      });
    }
  }

  const configNow = ownedDigest.config(state.config);
  const configReceipt = lastReceipt(p, "config");
  if (configReceipt) {
    if (configNow !== configReceipt.ownedPost) {
      out.push({
        kind: "config", class: "config drifted", target: ".story/config.json",
        observed: "project, type, language or recipe stages changed after setup wrote them", expected: "the values setup wrote",
        resolutions: ["accept-current", "restore-planned", "stop"], ref: {},
      });
    }
  } else {
    const pre = p.preImages.find((x) => x.target === ".story/config.json");
    const base = lastReceipt(p, "config-baseline")?.ownedPost ?? (pre ? ownedDigest.config(JSON.parse(pre.content) as Config) : null);
    if (base !== null && configNow !== base) {
      out.push({
        kind: "config-pre", class: "config drifted", target: ".story/config.json",
        observed: "project, type, language or recipe stages changed after setup recorded the scaffold's config", expected: "the recorded pre-image",
        resolutions: ["accept-current", "stop"], ref: {},
      });
    }
  }

  for (const f of plan.governance.files) {
    const path = posix.normalize(f.path);
    const target = insideProject(root, f.path);
    const current = await readOrNull(target);
    const r = lastReceipt(p, `governance:${path}`);
    if (r) {
      if ((current === null ? ABSENT : sha256(current)) === r.ownedPost) continue;
      out.push({
        kind: "governance-drift", class: "governance file drifted", target: f.path,
        observed: current === null ? "the file is gone" : "bytes setup did not write", expected: "the bytes setup wrote or the owner kept",
        resolutions: ["keep-current", "stop"], ref: { path },
      });
    } else if (current !== null && current !== f.content) {
      await leaveProposed(root, target, f.path, p.setupId, f.content);
      out.push({
        kind: "occupied", class: "user-owned target occupied", target: f.path,
        observed: `${current.length} bytes that are not setup's`,
        expected: `setup's ${f.content.length} bytes, left beside it as ${posix.basename(f.path)}.storybloq-${p.setupId}.proposed`,
        resolutions: ["keep-current", "stop"], ref: { path },
      });
    }
  }

  if (plan.git.gitignore.length > 0) {
    const target = join(root, ".gitignore");
    const current = await readOrNull(target);
    const missing = missingEntries(current, plan.git.gitignore);
    const r = lastReceipt(p, "gitignore");
    if (r) {
      if (r.ownedPost !== KEPT && missing.length > 0) {
        out.push({
          kind: "gitignore-drift", class: "governance file drifted", target: ".gitignore",
          observed: current === null ? "the file is gone" : `missing ${missing.join(", ")}`, expected: "setup's entries",
          resolutions: ["keep-current", "stop"], ref: {},
        });
      }
    } else if (current !== null && missing.length > 0) {
      // A change to a file the user owns is never made by the engine (plan v5 1f).
      await leaveProposed(root, target, ".gitignore", p.setupId, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${missing.join("\n")}\n`);
      out.push({
        kind: "pointer", class: "pointer edit owed", target: ".gitignore",
        observed: `missing ${missing.join(", ")}`, expected: `the entries in .gitignore.storybloq-${p.setupId}.proposed`,
        resolutions: ["applied", "keep-current", "stop"], ref: {},
      });
    }
  }

  for (const ptr of plan.governance.pointers ?? []) {
    const f = await pointerFinding(root, p, ptr);
    if (f) out.push(f);
  }

  const config = state.config;
  if (plan.checkpoints.length > 0 && !hasReceipt(p, "enable") && config.team?.enabled === true
    && enableCheckpointsStampUnlocked(config, IMMUTABLE_EVIDENCE_SCHEMA_VERSION).status !== "already") {
    out.push({
      kind: "enable", class: "schema-5 enable refused", target: ".story/config.json",
      observed: `a team ledger at schema ${config.schemaVersion ?? "unset"}`,
      expected: `schema ${IMMUTABLE_EVIDENCE_SCHEMA_VERSION}: run storybloq checkpoint enable --immutable-evidence and resume, or drop the checkpoints`,
      resolutions: ["drop-checkpoints", "stop"], ref: {},
    });
  }

  const noteReceipt = lastReceipt(p, "setup-note");
  if (noteReceipt) {
    const block = frozenAt(p, noteReceipt.revision);
    const note = state.notes.find((n) => {
      const meta = parseSetupMeta("note", n);
      return meta.kind === "record" && meta.meta.record === "final" && meta.meta.setupId === p.setupId;
    });
    if (!block || !note || note.content !== block.setupNote) {
      out.push(stopOnly("setup note edited", noteReceipt.target.slice("note:".length), note ? "content setup did not write" : "the setup note is gone", "the frozen setup note"));
    }
  }
  const handoverReceipt = lastReceipt(p, "handover");
  if (handoverReceipt) {
    const path = handoverReceipt.target.slice("file:".length);
    const block = frozenAt(p, handoverReceipt.revision);
    const current = await readOrNull(insideProject(root, path));
    if (!block || current !== block.handover.content) {
      out.push(stopOnly("handover edited", path, current === null ? "the handover is gone" : "content setup did not write", "the frozen handover"));
    }
  }
  return out;
}

/** A ticket or checkpoint with its planned owned fields; everything else, the checkpoint content included, kept. */
function restoredTicket(plan: SetupPayload, planned: PlannedItem, t: Ticket, date: string): Ticket {
  if (planned.kind === "issue") return t;
  // An explicit planned status is restored with its date: complete on the setup's day, open with none.
  const status = planned.kind === "ticket" && planned.item.status !== undefined
    ? (planned.item.status === "complete" ? { status: "complete", completedDate: date } : { status: "open", completedDate: null })
    : {};
  return {
    ...t,
    title: planned.item.title,
    ...(planned.kind === "ticket" && { type: planned.item.type }),
    phase: phaseIdOf(plan, planned.item.phase),
    description: planned.item.description,
    ...status,
  } as Ticket;
}

function restoredIssue(planned: SetupPayload["issues"][number], i: Issue): Issue {
  return { ...i, title: planned.title, impact: plannedImpact(planned), components: planned.labels } as Issue;
}

function ambiguities(findings: readonly Finding[]): SetupStop {
  const reason = findings.length === 1
    ? `the owner must resolve ${findings[0]!.class} at ${findings[0]!.target}`
    : `the owner must resolve ${findings.length} ambiguities`;
  return new SetupStop(4, reason, findings.map(ambiguityLine));
}

// --- Finalization (plan v5 6a) ------------------------------------------------

/** Keys whose item the owner adopted from the existing ledger rather than setup creating it. */
function adoptedKeys(p: SetupPayload): Set<string> {
  return new Set(p.amendments.filter((a) => a.resolution.startsWith("adopt ")).map((a) => a.target.split(" ")[0]!));
}

function userCounts(state: ProjectState, p: SetupPayload, adopted: ReadonlySet<string>) {
  const phases = p.phases.filter((ph) => state.roadmap.phases.some((x) => x.id === ph.id)).length;
  const keyed = (key: string) => !adopted.has(key) && keyedTicket(state, p.setupId, key) !== undefined;
  return {
    phases,
    tickets: p.tickets.filter((t) => keyed(t.key)).length,
    built: p.tickets.filter((t) => keyed(t.key) && plannedStatus(t) === "complete").length,
    checkpoints: p.checkpoints.filter((c) => keyed(c.key)).length,
    issues: p.issues.filter((i) => !adopted.has(i.key) && keyedIssue(state, p.setupId, i.key)).length,
  };
}

const WAIT_ORDER = ["the owner", "verification", "other work"] as const;

/**
 * Why nothing in the setup is ready (plan v5 6c): every open item is an owner
 * checkpoint or waits on an open blocker. Empty when something open waits on
 * nothing, or nothing is open, so the line never claims more than the ledger shows.
 * An open establishment ticket (T-538 S3a-2) is waited on as verification.
 */
function waitingOn(state: ProjectState, keyedIds: ReadonlySet<string>): string {
  const reasons = new Set<(typeof WAIT_ORDER)[number]>();
  const open = (id: string) => {
    const t = state.ticketByID(id);
    return t !== undefined && ticketCompletion(state, t) !== "complete" ? t : undefined;
  };
  for (const id of keyedIds) {
    const t = open(id);
    if (!t) continue;
    if (hasOwnerCheckpoint(t)) {
      reasons.add("the owner");
      continue;
    }
    const blockers = t.blockedBy.map(open).filter((b): b is Ticket => b !== undefined);
    if (blockers.length === 0) return "";
    for (const b of blockers) {
      if (hasOwnerCheckpoint(b)) reasons.add("the owner");
      else if (isEstablishment(b as unknown as Record<string, unknown>)) reasons.add("verification");
      else if (!keyedIds.has(b.id)) reasons.add("other work");
    }
  }
  const named = WAIT_ORDER.filter((r) => reasons.has(r));
  return named.length > 0 ? ` (everything open waits on ${named.join(" and ")})` : "";
}

/**
 * The live report's pending lines (T-538 S3a-2), from the setup verification
 * record when it is this setup's: a verified stage drops out, a left-off one
 * says so, and a test stage whose establishment ticket a writer outside the
 * guard closed without a result names the reopen. Null when the record is
 * absent, unreadable or another setup's: the payload's lines stand, as for a
 * legacy setup.
 */
function recordPendingLines(state: ProjectState, p: SetupPayload): PendingStageLine[] | null {
  const read = readRecord(state.config);
  if (read.kind !== "ok" || read.record.setupId !== p.setupId) return null;
  const record = read.record;
  const several = record.components.length > 1;
  const closedWithoutResult = (component: string): string | null => {
    for (const t of p.tickets) {
      if (t.establishes?.component !== component) continue;
      const ticket = keyedTicket(state, p.setupId, t.key);
      if (ticket === undefined || ticket.status !== "complete") continue;
      const meta = parseSetupMeta("ticket", ticket);
      if (meta.kind === "item" && meta.meta.verification !== undefined && meta.meta.verification.result === undefined) return displayIdOf(ticket);
    }
    return null;
  };
  const lines: PendingStageLine[] = [];
  for (const stage of STAGES_USED[record.level]) {
    if (stage === "VERIFY" && !record.verifyApplies) continue;
    for (const c of record.components) {
      const ev = stage === "VERIFY" ? c.verify : stage === "BUILD" ? c.build : c.test;
      if (ev === null || (ev.status !== "pending" && ev.status !== "left-off")) continue;
      const command = "command" in ev ? ev.command : ev.startCommand;
      const closed = ev.status === "pending" && stage !== "BUILD" && stage !== "VERIFY" ? closedWithoutResult(c.id) : null;
      const reason = ev.status === "left-off"
        ? "left off by the owner"
        : closed !== null
          ? `closed without verification; run storybloq setup-verify --ticket ${closed} --reopen`
          : ev.reason ?? "pending";
      lines.push({ stage, component: several ? c.id : null, command, reason });
    }
  }
  return lines;
}

/**
 * The core report lines (plan v5 6c), computed once at the freeze from the
 * ledger and kept verbatim. The live report (`live`) reads its pending lines
 * from the setup verification record.
 */
export function setupReportLines(state: ProjectState, p: SetupPayload, options: { live?: boolean } = {}): string[] {
  const adopted = adoptedKeys(p);
  const counts = userCounts(state, p, adopted);
  const initial = computeInitialStages(activationInput(p));
  const stages = initial.stages;
  const pending = (options.live === true ? recordPendingLines(state, p) : null) ?? initial.pending;
  // Review r1 #6: enablement is the ledger config's; a stage an accepted amendment changed says so.
  // Review r2 #3: through the recipe's defaults-and-overrides merge execution uses, so a missing override reads the default.
  const effective = effectiveStages(state.config);
  const ledgerOn = (name: string) => effective[name]?.enabled === true;
  const onOff = (on: boolean) => (on ? "on" : "off");
  const on = Object.keys(stages).filter(ledgerOn);
  const keptStages = Object.entries(stages)
    .filter(([name, s]) => ledgerOn(name) !== (s.enabled === true))
    .map(([name, s]) => `${name} ${onOff(ledgerOn(name))} (proposed ${onOff(s.enabled === true)})`);
  const keyedIds = new Set(
    [...p.tickets, ...p.checkpoints].map((t) => keyedTicket(state, p.setupId, t.key)?.id).filter((id): id is string => id !== undefined),
  );
  const ready = partitionByActionability(recommend(state, 10).recommendations).actionablePool.filter((r) => r.kind === "ticket" && keyedIds.has(r.id));
  const label = (r: { id: string; displayId?: string; title: string }) => `${r.displayId ?? r.id} "${r.title}"`;
  const config = state.config;
  // Review r1 #2: the facts are the ledger's; where they are not the package's, one line says so.
  const kept = PROJECT_FACTS.filter((f) => config[f] !== proposedFact(p, f)).map((f) => `${f} "${config[f]}" (proposed "${proposedFact(p, f)}")`);
  const lines = [
    `Setup ${p.setupId}: ${config.project} (${config.type}, ${config.language})`,
    ...(kept.length > 0 ? [`Kept current: ${kept.join(", ")}`] : []),
    `Created: ${counts.phases} phases, ${counts.tickets} tickets${counts.built > 0 ? ` (${counts.built} already built)` : ""}, ${counts.checkpoints} checkpoints, ${counts.issues} issues${adopted.size > 0 ? `; adopted: ${adopted.size}` : ""}`,
    `Quality: ${p.quality.level}; stages on: ${on.length > 0 ? on.join(", ") : "none"}${keptStages.length > 0 ? `; kept current: ${keptStages.join(", ")}` : ""}`,
    ...pending.map((l) => `Pending: ${l.stage}${l.component === null ? "" : ` (${l.component})`}: ${l.command} (pending: ${l.reason})`),
    `Governance: ${p.governance.files.length > 0 ? p.governance.files.map((f) => f.path).join(", ") : "none"}; canonical facts: ${p.governance.canonicalFactsPath}`,
    ...(options.live === true ? liveLines(state, p, ledgerOn) : []),
    ...p.review.lines.map((l) => `Review: ${l}`),
    `Ready to build: ${ready.length > 0 ? ready.map(label).join(", ") : "none"}`,
    `First story: ${ready.length > 0 ? label(ready[0]!) : `none${waitingOn(state, keyedIds)}`}`,
  ];
  return lines;
}

/**
 * The live report's state lines (T-538 S3b), never frozen into the
 * historical report: each setup checkpoint, ready or waiting on its open
 * blockers, and each recipe stage the level uses, on or off and why.
 */
function liveLines(state: ProjectState, p: SetupPayload, ledgerOn: (stage: string) => boolean): string[] {
  const lines: string[] = [];
  for (const cp of p.checkpoints) {
    const ticket = keyedTicket(state, p.setupId, cp.key);
    if (ticket === undefined) continue;
    const parsed = parseOwnerCheckpoint(ticket);
    const owner = parsed.kind === "ok" ? parsed.checkpoint.owner : p.ownerLabel;
    const waiting = ticket.blockedBy
      .map((ref) => state.resolveTicketRef(ref))
      .map((r) => (r.kind === "found" ? (state.releasesDependency(r.item) ? null : displayIdOf(r.item)) : "an unresolved blocker"))
      .filter((x): x is string => x !== null);
    const now = checkpointState(ticket);
    const status = now !== "pending" ? (now ?? "unrecognized") : checkpointReady(state, ticket) ? "ready" : `waiting on ${waiting.join(", ")}`;
    lines.push(`Checkpoint: ${cp.title} (${cp.kind}, owner ${owner}): ${status}`);
  }
  const read = readRecord(state.config);
  if (read.kind !== "ok" || read.record.setupId !== p.setupId) return lines;
  const record = read.record;
  for (const stage of STAGES_USED[record.level]) {
    if (stage === "VERIFY" && !record.verifyApplies) {
      lines.push("Verification: VERIFY: off (level)");
      continue;
    }
    const component = stage === "VERIFY" ? "verify" : stage === "BUILD" ? "build" : "test";
    const evidence = record.components.map((c) => c[component]).filter((e): e is NonNullable<typeof e> => e !== null && e !== undefined);
    if (ledgerOn(stage)) {
      lines.push(`Verification: ${stage}: on (${evidence.length > 0 && evidence.every((e) => e.status === "verified") ? "verified" : "established"})`);
      continue;
    }
    if (evidence.some((e) => e.status === "pending")) {
      const open = p.tickets
        .filter((t) => t.establishes?.stage === component)
        .map((t) => keyedTicket(state, p.setupId, t.key))
        .filter((t): t is Ticket => t !== undefined && t.status !== "complete")
        .map((t) => displayIdOf(t));
      lines.push(`Verification: ${stage}: off (pending${open.length > 0 ? `: ${open.join(", ")} open` : ""})`);
    } else if (evidence.some((e) => e.status === "left-off")) {
      lines.push(`Verification: ${stage}: off (left off)`);
    } else {
      lines.push(`Verification: ${stage}: off (level)`);
    }
  }
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

function handoverContent(p: SetupPayload, report: string, supersedes?: { revision: string; file: string }): string {
  return [
    supersedes ? `Setup record: ${p.setupId} handover, revision ${digest12(supersedes.revision)}, supersedes ${supersedes.file}` : `Setup record: ${p.setupId} handover`,
    "",
    `# Setup ${p.setupId}`,
    "",
    report,
    "",
    "The setup is complete; the progress note is archived. Start with the first story above.",
    "",
  ].join("\n");
}

/**
 * Freezes the finalization contents for the current revision. After an
 * amendment (plan v5 6a): contents byte-equal to the old block re-stamp its
 * receipts to the new revision; otherwise the old block is kept as history
 * and the finalization steps run again at the new one, the handover as a new
 * file that names the one it supersedes.
 */
async function stepFreeze(ctx: StepContext): Promise<void> {
  const p = ctx.progress.payload;
  const revision = effectiveRevision(p);
  const report = setupReportLines(ctx.lr.state, effectivePlan(p)).join("\n");
  const setupNote = setupNoteContent(effectivePlan(p), report);
  const old = p.frozen;
  let next: SetupPayload;
  if (old && old.setupNote === setupNote && old.historicalReport === report) {
    const frozen = { ...old, revision };
    const receipts = p.receipts.map((r) => (r.revision === old.revision ? { ...r, revision } : r));
    next = { ...p, frozen, receipts };
    ctx.out.push(`-> storybloq · finalization re-stamped to revision ${digest12(revision)} (contents unchanged)`);
  } else {
    const prior = lastReceipt(p, "handover");
    const priorFile = prior ? posix.basename(prior.target.slice("file:".length)) : null;
    const slug = `${ctx.today}-setup-${p.setupId.toLowerCase()}`;
    const frozen = {
      revision,
      setupNote,
      handover: priorFile === null
        ? { path: `.story/handovers/${slug}.md`, content: handoverContent(p, report) }
        : { path: `.story/handovers/${slug}-${digest12(revision)}.md`, content: handoverContent(p, report, { revision, file: priorFile }) },
      historicalReport: report,
    };
    next = { ...p, frozen, frozenHistory: old ? [...p.frozenHistory, { ...old, superseded: true }] : p.frozenHistory };
    if (old) ctx.out.push(`-> storybloq · finalization frozen again at revision ${digest12(revision)}`);
  }
  const payload = withReceipt(next, { step: "freeze", target: "frozen", ownedPre: null, ownedPost: digestOf(next.frozen), revision });
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
    const prior = lastReceipt(p, "setup-note");
    if (!prior) {
      throw ambiguity({ class: "corrupted receipt state", target: existing.id, observed: "a setup note with no receipt", expected: "no setup note before its receipt", resolutions: ["stop"] });
    }
    // Brought to the new revision only while it still holds the bytes of the revision it was written at.
    if (existing.content !== frozenAt(p, prior.revision)?.setupNote) {
      throw ambiguity({ class: "setup note edited", target: existing.id, observed: "content setup did not write", expected: "the frozen setup note", resolutions: ["stop"] });
    }
    const op = await prepareNoteWrite({ ...existing, content: frozen.setupNote, updatedDate: ctx.today } as Note, ctx.root);
    await commit(ctx, [op], { step: "setup-note", target: `note:${existing.id}`, ownedPre: ownedDigest.bytes(existing.content), ownedPost: ownedDigest.bytes(frozen.setupNote), revision: frozen.revision });
    ctx.out.push(`-> storybloq · setup note ${label(existing)} brought to revision ${digest12(frozen.revision)}`);
    return;
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
  const fail = (why: string, detail: readonly string[] = []) => new SetupStop(3, `the finalization gate refused: ${why}`, detail);
  if (effectiveRevision(p) !== frozen.revision) throw fail("the payload revision is not the frozen one");
  // The ledger as it is in this hold, not as the validation receipt saw it (review r1 #5).
  const errors = validateProject(ctx.lr.state).findings.filter((f) => f.level === "error");
  if (errors.length > 0) throw fail(`validation found ${errors.length} error(s); fix them and resume`, errors.map((e) => `Validation error: ${e.message}`));
  for (const step of FINALIZATION_STEPS) {
    const r = lastReceipt(p, step);
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
  for (const step of planSteps(effectivePlan(payload!))) {
    await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async (lr) => {
      const progress = readProgress(lr.state, setupId);
      const ctx = { root, lr, progress, today: localDateOf(new Date()), out };
      if (stepDone(progress.payload, step.id)) {
        await step.tidy?.(ctx);
        return;
      }
      // The whole plan, classified in the same hold as the step's write: its compare-and-set.
      const findings = await classifySetup(root, lr.state, progress.payload);
      if (findings.length > 0) throw ambiguities(findings);
      await step.run(ctx);
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

/** Runs one entry and turns a stop, a busy lock or any other failure into its exit code and lines. */
async function guarded(setupId: string, out: string[], run: () => Promise<SetupApplyResult>): Promise<SetupApplyResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SetupStop) {
      const resume = err.exitCode === 2 ? "" : ` Resume with storybloq setup-apply --resume --setup ${setupId}.`;
      return { exitCode: err.exitCode, lines: [...out, ...err.detail, `Setup stopped: ${err.reason}.${resume}`], setupId };
    }
    if (isLockBusy(err)) {
      return { exitCode: 7, lines: [...out, "Setup stopped: the project lock is busy (another storybloq writer holds it); retry when it finishes."], setupId };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 3, lines: [...out, `Setup stopped: ${message}. Resume with storybloq setup-apply --resume --setup ${setupId}.`], setupId };
  }
}

async function finish(root: string, setupId: string, out: string[], options: SetupApplyOptions, start: Start): Promise<SetupApplyResult> {
  if (start.kind === "complete") {
    return { exitCode: 0, lines: [...out, ...start.report.split("\n"), `Setup applied: ${setupId} (already complete; nothing written)`], setupId };
  }
  const report = await runSteps(root, setupId, out, options);
  return { exitCode: 0, lines: [...out, ...report.split("\n"), `Setup applied: ${setupId}`], setupId };
}

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
  if (payload.receipts.length > 0 || payload.amendments.length > 0 || payload.preImages.length > 0 || payload.frozen !== null || payload.frozenHistory.length > 0) {
    return { exitCode: 2, lines: ["Setup refused: a new setup payload carries no receipts, amendments, pre-images or frozen block; resume an existing setup instead."], setupId: payload.setupId };
  }
  const out: string[] = [];
  return guarded(payload.setupId, out, async () => {
    // Before any write: every user-file path stays inside the project once resolved (review r1 #1).
    for (const f of payload.governance.files) await containedTarget(absRoot, f.path, true);
    for (const ptr of payload.governance.pointers ?? []) {
      if (!existsSync(await containedTarget(absRoot, ptr.path, true))) throw new SetupStop(2, `the pointer target ${ptr.path} does not exist; a pointer block goes into an entry file already there`);
    }
    const wrap = join(absRoot, ".story");
    let start: Start = { kind: "run" };
    if (existsSync(join(wrap, "config.json")) || !(await bootstrap(absRoot, payload, out, options))) {
      if (existsSync(join(wrap, SETUP_BOOTSTRAP_MANIFEST))) await finishPublishedBootstrap(absRoot, payload, options);
      start = await startOnProject(absRoot, payload, out, options);
    }
    return finish(absRoot, payload.setupId, out, options, start);
  });
}

/** This setup in an existing project: in progress, completed, or not here at all. */
async function locate(root: string, setupId: string, options: SetupApplyOptions): Promise<Start | null> {
  let found: Start | null = null;
  await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
    if (findProgress(state, setupId, "active").length > 0) {
      found = { kind: "run" };
      return;
    }
    const archived = findProgress(state, setupId, "archived");
    if (archived.length > 0) found = completedSetup(archived);
  });
  return found;
}

const refused = (setupId: string | null, why: string): SetupApplyResult => ({ exitCode: 2, lines: [`Setup refused: ${why}`], setupId });

/**
 * `setup-report --setup <id>` (plan v5 6c): the live report from the ledger as
 * it is now, or with `historical` the report frozen at finalization. Takes no
 * lock and writes nothing.
 */
export async function setupReport(root: string, setupId: string, opts: { historical?: boolean } = {}): Promise<SetupApplyResult> {
  const stop = (why: string): SetupApplyResult => ({ exitCode: 2, lines: [`Setup report: ${why}`], setupId });
  if (!SETUP_ID_PATTERN.test(setupId)) return stop(`"${setupId}" is not a setup id (SS-<8 hex>).`);
  const absRoot = resolve(root);
  if (!existsSync(join(absRoot, ".story", "config.json"))) return stop(`no setup ${setupId} in this folder.`);
  const { state } = await loadProject(absRoot);
  const payloads = [...findProgress(state, setupId, "active"), ...findProgress(state, setupId, "archived")].map((n) => parseSetupPayload(n.content));
  if (payloads.length === 0) return stop(`no setup ${setupId} in this project.`);
  const p = payloads.find((x) => hasReceipt(x, "archive")) ?? payloads[0]!;
  if (opts.historical !== true) return { exitCode: 0, lines: setupReportLines(state, effectivePlan(p), { live: true }), setupId };
  const frozen = p.frozen?.historicalReport;
  if (frozen === undefined) return stop(`setup ${setupId} has no frozen report yet; it is frozen when the setup finalizes.`);
  return { exitCode: 0, lines: frozen.split("\n"), setupId };
}

/**
 * `setup-apply --resume --setup <id>`: continues a setup from the ledger
 * alone, finishing a bootstrap from its manifest when the project was never
 * published. After completion it returns the frozen report with nothing
 * written.
 */
export async function setupResume(root: string, setupId: string, options: SetupApplyOptions = {}): Promise<SetupApplyResult> {
  const absRoot = resolve(root);
  if (!SETUP_ID_PATTERN.test(setupId)) return refused(null, `"${setupId}" is not a setup id (SS-<8 hex>).`);
  const out: string[] = [];
  return guarded(setupId, out, async () => {
    const wrap = join(absRoot, ".story");
    const manifest = await readManifest(wrap);
    if (manifest) {
      if (manifest.setupId !== setupId) {
        throw ambiguity({ class: "bootstrap manifest of another setup", target: `.story/${SETUP_BOOTSTRAP_MANIFEST}`, observed: `setup ${manifest.setupId}`, expected: `setup ${setupId}`, resolutions: [`resume ${manifest.setupId}`, "remove it by hand", "stop"] });
      }
      let approved: SetupPayload;
      try {
        approved = validateSetupPayload(manifest.payload);
      } catch {
        throw ambiguity({ class: "corrupted bootstrap manifest", target: `.story/${SETUP_BOOTSTRAP_MANIFEST}`, observed: "a payload that does not validate", expected: "the approved package", resolutions: ["stop"] });
      }
      if (existsSync(join(wrap, "config.json")) || !(await bootstrap(absRoot, approved, out, options))) {
        await finishPublishedBootstrap(absRoot, approved, options);
      }
    } else if (!existsSync(join(wrap, "config.json"))) {
      return refused(setupId, `no setup ${setupId} in this folder.`);
    }
    const start = await locate(absRoot, setupId, options);
    if (!start) return refused(setupId, `no setup ${setupId} in this project.`);
    return finish(absRoot, setupId, out, options, start);
  });
}

// --- Resolutions (plan v5 2a) -------------------------------------------------

export const ResolutionsSchema = z.array(z.object({
  target: z.string().min(1),
  resolution: z.string().min(1),
  ownerWords: z.string().min(1),
  reviewRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()).min(1);

export type SetupResolution = z.infer<typeof ResolutionsSchema>[number];

/**
 * A material amendment changes the reviewed package (plan v5 2a), so it
 * needs a completed or round-limit review of the amended packet's revision
 * in this setup's review store, or a recorded skip for this setup.
 */
function reviewProblem(root: string, p: SetupPayload, r: SetupResolution, env: NodeJS.ProcessEnv): string | null {
  const how = "run storybloq setup-review run --new-cycle on the amended packet, get the owner's approval, and pass its revision as reviewRevision";
  let setup;
  let paths;
  try {
    paths = setupPaths(env, root, p.setupId);
    setup = readSetup(paths);
  } catch {
    return `${r.target}: ${r.resolution} changes the approved package and this setup has no review record; ${how}`;
  }
  if (setup.skipped) return null;
  if (r.reviewRevision === undefined) return `${r.target}: ${r.resolution} changes the approved package; ${how}`;
  if (p.review.lines.some((l) => l.includes(digest12(r.reviewRevision!)))) {
    return `${r.target}: revision ${digest12(r.reviewRevision)} is the approved package's, not the amended one; ${how}`;
  }
  const verdict = classifyReview(loadRecords(paths), r.reviewRevision, setup.cycle);
  if (verdict.kind === "completed" || verdict.kind === "round-limit") return null;
  return `${r.target}: no completed or round-limit review for revision ${digest12(r.reviewRevision)}; ${how}`;
}

function isMaterial(f: Finding, resolution: string, plan: SetupPayload, state: ProjectState): boolean {
  switch (f.kind) {
    case "edited": return resolution === "accept-current";
    case "edge": return resolution === "accept-removal";
    case "occupied":
    case "enable": return true;
    case "config": return resolution === "accept-current" && stagesDiffer(plan, state.config);
    case "unkeyed": {
      if (!resolution.startsWith("adopt ")) return false;
      const id = resolution.slice("adopt ".length);
      const planned = plannedItems(plan).find((x) => x.item.key === f.ref.key)!;
      const item = state.ticketByID(id) ?? state.issues.find((i) => i.id === id)!;
      return itemDrift(plan, planned, item).length > 0;
    }
    default: return false;
  }
}

/** Resolutions that persist an amendment (plan v5 2a "What is persisted"); the others persist a receipt or a write. */
const AMENDS = new Set(["accept-current", "accept-removal", "keep-current", "replace", "drop-checkpoints"]);

/**
 * `setup-apply --resolve '<json>'`: records the owner's resolution of each
 * open ambiguity, with any write it needs, in one transaction under the
 * lock, then continues the setup. A resolution that names no open
 * ambiguity, or a material amendment without its review, is refused with
 * nothing written. `stop` writes nothing.
 */
export async function setupResolve(root: string, setupId: string, raw: unknown, options: SetupApplyOptions = {}): Promise<SetupApplyResult> {
  const absRoot = resolve(root);
  if (!SETUP_ID_PATTERN.test(setupId)) return refused(null, `"${setupId}" is not a setup id (SS-<8 hex>).`);
  const parsed = ResolutionsSchema.safeParse(Array.isArray(raw) ? raw : (raw as { resolutions?: unknown } | null)?.resolutions);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return refused(setupId, `the resolutions are not valid: ${issue.path.join(".") || "(root)"} ${issue.message}. Pass [{"target", "resolution", "ownerWords", "reviewRevision"?}].`);
  }
  const resolutions = parsed.data;
  if (resolutions.some((r) => r.resolution === "stop")) {
    return { exitCode: 3, lines: [`Setup stopped: the owner chose stop; nothing was written. Resume with storybloq setup-apply --resume --setup ${setupId}.`], setupId };
  }
  const env = options.env ?? process.env;
  const out: string[] = [];
  return guarded(setupId, out, async () => {
    let refusal: string | null = null;
    await withProjectLock(absRoot, { strict: true, deadlineMs: options.lockDeadlineMs }, async (lr) => {
      refusal = await resolveUnderLock(absRoot, lr, setupId, resolutions, env, out);
    });
    if (refusal !== null) return { exitCode: 2, lines: [...out, `Setup refused: ${refusal}`], setupId };
    return finish(absRoot, setupId, out, options, { kind: "run" });
  });
}

async function resolveUnderLock(root: string, lr: LoadResult, setupId: string, resolutions: readonly SetupResolution[], env: NodeJS.ProcessEnv, out: string[]): Promise<string | null> {
  const state = lr.state;
  const active = findProgress(state, setupId, "active");
  if (active.length === 0) {
    return findProgress(state, setupId, "archived").length > 0 ? `setup ${setupId} is complete; there is nothing to resolve.` : `no setup ${setupId} in this project.`;
  }
  const today = localDateOf(new Date());
  if (active.length > 1) {
    // Two progress notes for one setup: keep one, archive the rest unfinished.
    const [r, ...rest] = resolutions;
    const keep = r!.resolution.startsWith("keep ") ? r!.resolution.slice("keep ".length) : null;
    if (rest.length > 0 || r!.target !== setupId || keep === null || !active.some((n) => n.id === keep)) {
      return `the open ambiguity is ${active.length} active progress notes for ${setupId}; resolve it alone with target ${setupId} and one of: ${active.map((n) => `keep ${n.id}`).join(", ")}.`;
    }
    const ops = await Promise.all(active.filter((n) => n.id !== keep).map((n) => prepareNoteWrite({ ...n, status: "archived", updatedDate: today } as Note, root)));
    await runTransactionUnlocked(root, ops.map((o) => ({ op: "write" as const, ...o })));
    out.push(`-> storybloq · resolved ${setupId}: ${r!.resolution}`);
    return null;
  }

  const progress = readProgress(state, setupId);
  const p = progress.payload;
  const plan = effectivePlan(p);
  const findings = await classifySetup(root, state, p);
  const tickets = new Map<string, Ticket>();
  const issues = new Map<string, Issue>();
  let roadmap: Roadmap | null = null;
  let config: Config | null = null;
  const receipts: Receipt[] = [];
  const amendments: SetupPayload["amendments"] = [];
  const cleanup: Array<() => Promise<void>> = [];
  // A resolved line is printed only once its transaction commits, so a batch refused at a later answer prints none (review r2 #2).
  const resolved: string[] = [];
  const ticket = (id: string) => tickets.get(id) ?? state.ticketByID(id)!;
  const issue = (id: string) => issues.get(id) ?? state.issues.find((i) => i.id === id)!;
  // A restore that moves a ticket into or out of complete is a lifecycle change: it meets the ordinary
  // completion and reopen authorisation here, in this hold, and a refusal writes nothing (review S3a-1 #1).
  const completing = new Map<string, string>();
  let ownership: CompletionGuardOptions | null = null;
  // Duplicate-key losers: an establishment's settlement is written under the creation authority's settlement case.
  const settled = new Set<string>();

  for (const r of resolutions) {
    const f = findings.find((x) => x.target === r.target && x.resolutions.includes(r.resolution));
    if (r.resolution === "applied" && r.target === ".gitignore") {
      // The agent made the approved edit; the gitignore step verifies it byte for byte and receipts it.
      const missing = missingEntries(await readOrNull(join(root, ".gitignore")), plan.git.gitignore);
      if (hasReceipt(p, "gitignore") || missing.length > 0) return `.gitignore: applied, but it does not list ${missing.join(", ") || "the approved entries"} yet.`;
      resolved.push(`-> storybloq · resolved .gitignore: applied`);
      continue;
    }
    const ptr = (plan.governance.pointers ?? []).find((x) => x.path === r.target);
    if (r.resolution === "applied" && ptr) {
      // The owner made the edit; the pointer step finds the block byte for byte and receipts it.
      const current = await readOrNull(join(root, ptr.path));
      if (hasReceipt(p, `pointer:${ptr.path}`) || current === null || !current.includes(ptr.block)) return `${ptr.path}: applied, but it does not carry setup's pointer block yet.`;
      resolved.push(`-> storybloq · resolved ${ptr.path}: applied`);
      continue;
    }
    if (!f) {
      const open = findings.map((x) => `${x.target} (${x.resolutions.join(" | ")})`);
      return `no open ambiguity at ${r.target} takes ${r.resolution}; open: ${open.length > 0 ? open.join("; ") : "none"}.`;
    }
    const material = isMaterial(f, r.resolution, plan, state);
    if (material) {
      const problem = reviewProblem(root, p, r, env);
      if (problem !== null) return problem;
    }
    if (AMENDS.has(r.resolution) || r.resolution.startsWith("adopt ")) {
      amendments.push({ class: f.class, target: f.target, resolution: r.resolution, ownerWords: r.ownerWords, at: new Date().toISOString(), material, ...(r.reviewRevision !== undefined && material && { reviewRevision: r.reviewRevision }) });
    }
    const baseline = (step: string, target: string, ownedPost: string, extra: Partial<Receipt> = {}) =>
      receipts.push({ step, target, ownedPre: lastReceipt(p, step)?.ownedPost ?? null, ownedPost, ...extra });

    switch (f.kind) {
      case "edited": {
        const step = f.ref.step!;
        if (f.ref.entity === "phase") {
          const ph = plan.phases.find((x) => x.key === f.ref.key)!;
          const rm = roadmap ?? state.roadmap;
          const at = rm.phases.findIndex((x) => x.id === ph.id);
          const phase = r.resolution === "restore-planned" ? { ...rm.phases[at]!, name: ph.name, label: ph.label, description: ph.description } : rm.phases[at]!;
          if (r.resolution === "restore-planned") roadmap = { ...rm, phases: rm.phases.map((x, j) => (j === at ? phase : x)) } as Roadmap;
          baseline(step, `phase:${ph.id}`, ownedDigest.phase({ ...phase, description: phase.description ?? "" }, at));
        } else if (f.ref.entity === "issue") {
          const planned = plan.issues.find((x) => x.key === f.ref.key)!;
          const next = r.resolution === "restore-planned" ? restoredIssue(planned, issue(f.ref.id!)) : issue(f.ref.id!);
          if (r.resolution === "restore-planned") issues.set(next.id, next);
          baseline(step, `issue:${next.id}`, ownedDigest.issue(next));
        } else {
          const planned = plannedItems(plan).find((x) => x.item.key === f.ref.key)!;
          const current = ticket(f.ref.id!);
          let next = r.resolution === "restore-planned" ? restoredTicket(plan, planned, current, progress.note.createdDate) : current;
          // Every restore that writes complete work, or takes work out of complete, is a lifecycle write.
          if (JSON.stringify(next) !== JSON.stringify(current) && (next.status === "complete" || current.status === "complete")) {
            // Evidence is gathered when a verdict needs it, as the ticket updater does: a reopen, or claim material.
            const needsOwnership = (current.status === "complete" && next.status !== "complete") || hasClaimMaterial(next);
            let guard: CompletionGuardOptions = { completingUser: null, activeEpochs: [] };
            if (needsOwnership) {
              try {
                guard = ownership ??= await collectCompletionOwnership(root);
              } catch (err) {
                if (!(err instanceof CompletionOwnershipUnavailable)) throw err;
                return `${r.target}: restore-planned refused: ownership cannot be verified: ${err.unreadable ? err.message : `local session state could not be read (${err.message}).`}`;
              }
            }
            // claimFreeReopen holds only here: the owner's own restore-planned answer, during this unfinished setup,
            // restoring the setup's planned open. The ticket CLI keeps --force for a claim-free reopen (ISS-981).
            const decision = authoriseStatusChange(current, next, guard, { claimFreeReopen: true }, label(current));
            if (!decision.ok) return `${r.target}: restore-planned refused: ${decision.reason}`;
            next = decision.ticket;
            if (next.status === "complete" && current.status !== "complete") completing.set(next.id, r.target);
          }
          if (r.resolution === "restore-planned") tickets.set(next.id, next);
          baseline(step, `ticket:${next.id}`, ownedDigest.ticket(next, plannedOf(planned)));
        }
        break;
      }
      case "duplicate": {
        const keep = r.resolution.slice("keep ".length);
        for (const other of allKeyed(state, setupId, f.ref.key!).filter((x) => x.id !== keep)) {
          // The loser keeps every other setup field (an establishment's spec included) and gives up its key.
          const kept = (state.ticketByID(other.id) ? ticket(other.id) : issue(other.id)) as (Ticket | Issue) & { setup: Record<string, unknown> };
          const setup = { ...kept.setup, supersededBy: keep };
          if (state.ticketByID(other.id)) {
            tickets.set(other.id, { ...ticket(other.id), setup } as Ticket);
            settled.add(other.id);
          } else issues.set(other.id, { ...issue(other.id), setup } as Issue);
          receipts.push({ step: `supersede:${other.id}`, target: other.id, ownedPre: null, ownedPost: sha256(keep) });
        }
        break;
      }
      case "unkeyed": {
        if (r.resolution === "replace") break;
        const id = r.resolution.slice("adopt ".length);
        const setup = { setupId, key: f.ref.key! };
        if (f.ref.kind === "issue") {
          const next = { ...issue(id), setup } as Issue;
          issues.set(id, next);
          receipts.push({ step: `item:${f.ref.key}`, target: `issue:${id}`, ownedPre: null, ownedPost: ownedDigest.issue(next) });
        } else {
          const next = { ...ticket(id), setup } as Ticket;
          tickets.set(id, next);
          receipts.push({ step: `item:${f.ref.key}`, target: `ticket:${id}`, ownedPre: null, ownedPost: ownedDigest.ticket(next, plan.tickets.find((x) => x.key === f.ref.key)) });
        }
        break;
      }
      case "edge": {
        const step = `wire:${f.ref.key}`;
        if (r.resolution === "restore-edge") {
          const t = ticket(f.ref.item!);
          const blockedBy = [...t.blockedBy, f.ref.blocker!];
          const cycle = edgeCycle((id) => ticket(id)?.blockedBy ?? [], t.id, blockedBy);
          if (cycle) throw cycleStop(r.target, cycle);
          tickets.set(t.id, { ...t, blockedBy } as Ticket);
          break;
        }
        const last = [...receipts].reverse().find((x) => x.step === step) ?? lastReceipt(p, step)!;
        const edges = (last.edges ?? []).filter(([, b]) => b !== f.ref.blocker);
        receipts.push({ step, target: last.target, ownedPre: last.ownedPost, ownedPost: ownedDigest.edges(edges.map(([, b]) => b)), edges });
        break;
      }
      case "config": {
        const next: Config = r.resolution === "restore-planned" ? plannedConfig(p, config ?? state.config) : state.config;
        if (r.resolution === "restore-planned") config = next;
        baseline("config", "config", ownedDigest.config(next));
        break;
      }
      case "config-pre":
        baseline("config-baseline", "config", ownedDigest.config(state.config));
        break;
      case "governance-drift":
      case "occupied": {
        const target = insideProject(root, f.ref.path!);
        const current = await readOrNull(target);
        baseline(`governance:${f.ref.path}`, `file:${f.ref.path}`, current === null ? ABSENT : sha256(current));
        if (f.kind === "occupied") cleanup.push(() => removeProposed(target, setupId));
        break;
      }
      case "gitignore-drift":
      case "pointer":
        baseline("gitignore", "file:.gitignore", KEPT);
        if (f.kind === "pointer") cleanup.push(() => removeProposed(join(root, ".gitignore"), setupId));
        break;
      case "entry-pointer":
      case "pointer-drift":
      case "proposal-conflict":
        // keep-current: the owner's file as it is, a waived pointer; only setup's own proposal is removed.
        baseline(`pointer:${f.ref.path}`, `file:${f.ref.path}`, KEPT, { outcome: "waived" });
        if (f.kind === "entry-pointer") cleanup.push(() => tidyPointer(root, f.ref.path!, p, out));
        break;
      default:
        break;
    }
    resolved.push(`-> storybloq · resolved ${r.target}: ${r.resolution}${material ? " (material, review recorded)" : ""}`);
  }

  const ops: Array<{ target: string; content: string }> = [];
  for (const t of tickets.values()) {
    if (!completing.has(t.id)) {
      ops.push(await prepareTicketWrite(t, root, settled.has(t.id) ? { verificationAuthority: ESTABLISHMENT_CREATION_AUTHORITY } : undefined));
      continue;
    }
    // The owner checkpoint rule and the evidence, as the ticket CLI's completion applies them.
    const completion = await prepareCompletionWrite(state, t, root);
    if (completion.kind === "checkpoint-blocked") return `${completing.get(t.id)}: restore-planned refused: ${describeCheckpointBlock(label(t), completion.checkpoints.map((c) => label(state.ticketByID(c) ?? { id: c })))}`;
    ops.push(completion.op);
  }
  for (const i of issues.values()) ops.push(await prepareIssueWrite(i, root));
  if (roadmap) ops.push(await prepareRoadmapWrite(roadmap, root));
  if (config) ops.push(await prepareConfigWrite(config, root));
  const payload = { ...p, receipts: [...p.receipts, ...receipts], amendments: [...p.amendments, ...amendments] };
  // The plan these resolutions leave must still be a valid plan before any of them is committed (review r1 #3).
  try {
    validateSetupPayload(effectivePlan(payload));
  } catch (err) {
    if (err instanceof SetupPayloadError) return `these resolutions would leave a plan that does not validate: ${err.message}`;
    throw err;
  }
  if (ops.length > 0 || receipts.length > 0 || amendments.length > 0) {
    ops.push(await progressWrite(root, progress, payload, today));
    await runTransactionUnlocked(root, ops.map((o) => ({ op: "write" as const, ...o })));
    if (config) invalidateResolutionWriteContext(root);
  }
  out.push(...resolved);
  for (const c of cleanup) await c();
  await setupApplySeams.fault("resolved");
  return null;
}
