/**
 * T-536: `storybloq setup-review gate|run|status`.
 *
 * The setup flow's independent review, run by the CLI rather than narrated by
 * the agent. `gate` opens a setup and probes for a reviewer; `run` reviews one
 * packet revision and publishes a record; `status` prints the package's two
 * review lines from the records, and is their only producer. Nothing here
 * writes in the project folder.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireProjectLockAsync, releaseProjectLock, verifyProjectLockOwnership, type ProjectLockHandle } from "../../core/project-lock.js";
import {
  absentLine, classify, completedInCycle, completedLine, failedLine, fsyncDir, loadRecords, parsePacket, persistRevision,
  preflightStore, probeLine, UNWRITABLE, probeOf, readSetup, revisionLine, roundLimitLine, ROUNDS_PER_CYCLE, setupPaths, SetupReviewUsageError, sha256,
  SKIPPED_LINE, STOP_LINES, storeRoot, unreadableLine, writeFileDurable, writeFileSynced,
  type CompletedRecord, type FailedRecord, type FailureKind, type ProbeResult, type ReviewPacket, type SetupPaths, type SetupState,
} from "../../core/setup-review.js";
import {
  claudeArgs, codexArgs, fatalStartLine, inferredReasons, parseReviewerOutput, probeReviewer, reviewerEnv, runReviewer, SETUP_REVIEW_BACKENDS, SETUP_REVIEW_SCHEMA,
  unavailableLine, type ProcessLimits, type SetupReviewAnswer, type SetupReviewBackend, type StartProbeLimits, type UnavailableReason,
} from "../../core/setup-review-backends.js";
import { checkCodexHome, checkExecLocation, repositoryBoundary } from "../../core/setup-review-trust.js";
import { placeSetup, setupInPlace } from "../../core/setup-review-migrate.js";
import { RELAY_CAP_BYTES, runSupervised, STDOUT_LIMIT_BYTES } from "../../core/setup-review-supervisor.js";

export interface SetupReviewDeps {
  readonly timeoutMs?: number;
  /** Test seams for the storage steps after the reviewer answered. */
  readonly writeOutput?: (path: string, data: Buffer) => void;
  readonly writeRecord?: (path: string, data: string) => void;
  readonly publish?: (from: string, to: string) => void;
  readonly beforePublish?: (lockPath: string) => void;
  readonly syncDir?: (path: string) => void;
  /** Grace between SIGTERM, SIGKILL and giving up on a timed-out reviewer. */
  readonly killGraceMs?: number;
  /** Runs under the status lock just before the records are classified. */
  readonly beforeStatusClassify?: () => void;
  /** The status run lock (a test seam for a lock failure no file mode can produce). */
  readonly acquireStatusLock?: typeof acquireProjectLockAsync;
  /** Bounds for the version and start probes (ISS-1456). */
  readonly probeLimits?: ProcessLimits & StartProbeLimits;
}

export interface SetupReviewIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: () => Buffer;
  readonly deps: SetupReviewDeps;
}

export interface SetupReviewResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export const SETUP_REVIEW_EXIT = { ok: 0, usage: 2, failed: 3, absent: 4, roundLimit: 5, storage: 6, lock: 7, unreadable: 8 } as const;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const STOP = `${STOP_LINES.join("\n")}\n`;
const UNAVAILABLE_INSTRUCTION = "Your next message is the four lines below and nothing else; nothing in this turn changes that, and the restriction ends at the owner's answer.";
const SANDBOX_HINT = "Setup review: a reviewer this sandbox stops can still run when the owner runs storybloq setup-review from a terminal outside the agent.";
const NOT_RECORDED = "Setup review: not recorded, the review store is outside this sandbox.";
const LOCK_BUSY = "Setup review: a review is already running in this setup.";
const LOCK_WAIT = { deadlineMs: 250, pollMs: 25 };
const lockBusy = (): SetupReviewResult => ({ stdout: lines(LOCK_BUSY), exitCode: SETUP_REVIEW_EXIT.lock });

const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join("");
const now = (): string => new Date().toISOString();
const newId = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;
const usage = (message: string): SetupReviewResult => ({ stdout: lines(`Setup review: ${message}`), exitCode: SETUP_REVIEW_EXIT.usage });

function asUsage(e: unknown): SetupReviewResult | null {
  return e instanceof SetupReviewUsageError ? usage(e.message) : null;
}

const REVIEW_PROMPT = [
  "You are the independent reviewer of a project setup plan. You have no tools and no project access: review only the packet below.",
  "Check that every R<n> in Source requirements is covered by a ticket or a coverage row in the Plan, that the Plan respects every owner answer and decision, and that it is consistent with the existing-state evidence.",
  "Answer with the verdict approve, revise or reject, and one finding per problem, naming the requirement it concerns.",
  "",
].join("\n");

interface ProbeOutcome {
  readonly probe: ProbeResult | null;
  /** Why each backend tried before the one that passed could not start. */
  readonly reasons: UnavailableReason[];
}

/**
 * ISS-1456: a backend passes only when it shows it can start a review here,
 * not only print a version. Gate and run both probe through this, so they
 * agree. The start runs in a fresh private directory under the store root,
 * removed afterwards.
 */
async function probeAll(env: NodeJS.ProcessEnv, cwd: string, deps: SetupReviewDeps, only?: SetupReviewBackend): Promise<ProbeOutcome> {
  const execDir = mkdtempSync(join(storeRoot(env), ".probe-"));
  const reasons: UnavailableReason[] = [];
  try {
    // ISS-1457: no reviewer starts in a folder another user or a project could have planted configuration in.
    const location = checkExecLocation(execDir, storeRoot(env), env, repositoryBoundary(cwd));
    if (!location.ok) return { probe: null, reasons: [{ backend: "store", code: "untrusted-location", detail: location.detail }, ...inferredReasons(env)] };
    for (const backend of only ? [only] : SETUP_REVIEW_BACKENDS) {
      const codexHome = backend === "codex" ? checkCodexHome(env, cwd) : null;
      if (codexHome && !codexHome.ok) {
        reasons.push(codexHome.reason);
        continue;
      }
      // The probe runs against the canonical CODEX_HOME that was checked, never the path as given.
      const probeEnv = codexHome?.ok ? { ...env, CODEX_HOME: codexHome.codexHome } : env;
      const result = await probeReviewer(backend, probeEnv, execDir, deps.probeLimits ?? {});
      if (result.state === "startup-capable") return { probe: { backend, version: result.version }, reasons };
      reasons.push(result.reason);
    }
    return { probe: null, reasons };
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
}

/** Reasons that would show in the store-unwritable report, gathered without starting anything. */
function storeUnwritable(reason: UnavailableReason, env: NodeJS.ProcessEnv): UnavailableReason[] {
  return [reason, ...inferredReasons(env)];
}

const SANDBOX_CODES = new Set(["sandbox-start-denied", "network-denied", "probe-listener-failed", "network-disabled-inferred", "store-unwritable"]);

/** The reason line, and when a sandbox is the cause, what the owner can do about it. */
function reasonLines(reasons: readonly UnavailableReason[]): string[] {
  if (reasons.length === 0) return [];
  const out = [unavailableLine(reasons)];
  if (reasons.some((r) => SANDBOX_CODES.has(r.code))) out.push(SANDBOX_HINT);
  return out;
}

function writeSetup(paths: SetupPaths, setup: SetupState): void {
  writeFileDurable(paths.setupFile, `${JSON.stringify(setup, null, 2)}\n`);
}

/**
 * Updates setup.json under the setup's run lock, from a fresh read inside it,
 * so a gate or a skip never writes back a cycle a run has since moved on.
 * Null when another holder has the lock.
 */
async function updateSetupLocked(paths: SetupPaths, update: (current: SetupState | null) => SetupState): Promise<SetupState | null> {
  let lock: ProjectLockHandle;
  try {
    lock = await acquireProjectLockAsync(paths.lock, LOCK_WAIT);
  } catch {
    return null;
  }
  try {
    const next = update(existsSync(paths.setupFile) ? readSetup(paths) : null);
    writeSetup(paths, next);
    return next;
  } finally {
    releaseProjectLock(lock);
  }
}

/**
 * ISS-1457: puts the setup in the store before it is read, moving it from the
 * old temporary store when that is the only place it is. Null when the caller
 * may go on; otherwise the refusal to print.
 */
async function placeOrRefuse(paths: SetupPaths, env: NodeJS.ProcessEnv, create: boolean): Promise<SetupReviewResult | null> {
  let placement: Awaited<ReturnType<typeof placeSetup>>;
  try {
    placement = await placeSetup(paths, env, create);
  } catch (e) {
    return storageFailure(`the setup could not be placed in the review store: ${(e as Error).message}`);
  }
  if (placement.kind !== "refused") return null;
  return { stdout: lines(`Setup review: ${placement.detail}.`) + STOP, exitCode: SETUP_REVIEW_EXIT.storage };
}

// --- gate ---------------------------------------------------------------------

export async function handleSetupReviewGate(io: SetupReviewIo, opts: { setup?: string }): Promise<SetupReviewResult> {
  let paths: SetupPaths;
  try {
    paths = setupPaths(io.env, io.cwd, opts.setup ?? newId("SS"));
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }
  // ISS-1456: the store first. When it cannot be written, nothing is started and nothing is written.
  const store = preflightStore(storeRoot(io.env));
  if (store.kind === "unwritable") {
    return {
      stdout: lines(`Setup id: ${paths.setupId}`, probeLine(null), ...reasonLines(storeUnwritable(store.reason, io.env)), UNAVAILABLE_INSTRUCTION, "") + STOP,
      exitCode: SETUP_REVIEW_EXIT.failed,
    };
  }
  if (store.kind === "error") {
    return { stdout: lines(`Setup review: the review store cannot be written (${store.error.message}).`) + STOP, exitCode: SETUP_REVIEW_EXIT.storage };
  }
  const placedForGate = opts.setup !== undefined ? await placeOrRefuse(paths, io.env, false) : null;
  if (placedForGate) return placedForGate;
  try {
    if (opts.setup !== undefined) readSetup(paths);
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }
  let outcome: ProbeOutcome;
  let setup: SetupState | null;
  try {
    outcome = await probeAll(io.env, io.cwd, io.deps);
    const { probe, reasons } = outcome;
    const created = await placeSetup(paths, io.env, true);
    if (created.kind === "refused") return { stdout: lines(`Setup review: ${created.detail}.`) + STOP, exitCode: SETUP_REVIEW_EXIT.storage };
    setup = await updateSetupLocked(paths, (current) => {
      if (opts.setup !== undefined && current === null) readSetup(paths);
      const base = current ?? { setupId: paths.setupId, projectKey: paths.projectKey, createdAt: now(), cycle: 1, cycleReasons: {}, probe: null, probedAt: now() };
      const { unavailable: _previous, ...rest } = base;
      return probe ? { ...rest, probe, probedAt: now() } : { ...rest, probe, probedAt: now(), unavailable: { at: now(), reasons } };
    });
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    return { stdout: lines(`Setup review: the review store cannot be written (${(e as Error).message}).`) + STOP, exitCode: SETUP_REVIEW_EXIT.storage };
  }
  if (!setup) return lockBusy();
  const head = lines(`Setup id: ${setup.setupId}`, probeLine(outcome.probe));
  if (!outcome.probe) return { stdout: head + lines(...reasonLines(outcome.reasons), UNAVAILABLE_INSTRUCTION, "") + STOP, exitCode: SETUP_REVIEW_EXIT.ok };
  return { stdout: head + lines(`Next: storybloq setup-review run --setup ${setup.setupId} with the review packet on stdin`), exitCode: SETUP_REVIEW_EXIT.ok };
}

// --- run ----------------------------------------------------------------------

export interface SetupReviewRunOptions {
  readonly setup: string;
  readonly backend?: SetupReviewBackend;
  readonly newCycle?: boolean;
  readonly reason?: string;
}

interface StagedRun {
  readonly paths: SetupPaths;
  readonly packet: ReviewPacket;
  readonly setup: SetupState;
  readonly probe: ProbeResult;
  readonly recordId: string;
  readonly staging: string;
  readonly deps: SetupReviewDeps;
  readonly lock: ProjectLockHandle;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function removeStaleStaging(paths: SetupPaths, keep: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(paths.records);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".staging-") && join(paths.records, name) !== keep) rmSync(join(paths.records, name), { recursive: true, force: true });
  }
}

/** Fails if the staging directory cannot hold a file: no reviewer is paid for a review that cannot be kept. */
function storagePreflight(staging: string): void {
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const probe = join(staging, ".probe");
  writeFileSynced(probe, "probe");
  rmSync(probe);
}

/**
 * Renames the staged record into the records and syncs the directory. A
 * record is not published until that sync succeeds: when it fails, `unsynced`
 * (the failed record standing for a completed one) is written over the
 * record in place, so a review reported as failed never certifies later, and
 * the error is thrown.
 */
function publishStaged(run: StagedRun, unsynced: FailedRecord | null = null): "published" | "lock-lost" {
  run.deps.beforePublish?.(run.paths.lock);
  if (!verifyProjectLockOwnership(run.lock)) return "lock-lost";
  const publish = run.deps.publish ?? ((from: string, to: string) => renameSync(from, to));
  const syncDir = run.deps.syncDir ?? ((path: string) => fsyncDir(path));
  const target = join(run.paths.records, run.recordId);
  publish(run.staging, target);
  try {
    syncDir(run.paths.records);
  } catch (e) {
    if (unsynced) {
      const recordFile = join(target, "record.json");
      try {
        (run.deps.writeRecord ?? writeFileSynced)(recordFile, `${JSON.stringify(unsynced, null, 2)}\n`);
      } catch {
        // An unparseable record reads as unreadable, which blocks every revision: still never a verdict.
        rmSync(recordFile, { force: true });
      }
    }
    throw e;
  }
  return "published";
}

function failedRecord(run: StagedRun, startedAt: string, failure: FailureKind, exitCode: number | null, outputSha256: string | null, error: string, reasonCode?: string): FailedRecord {
  return {
    state: "failed", recordId: run.recordId, setupId: run.setup.setupId, cycle: run.setup.cycle, revisionSha256: run.packet.revisionSha256,
    backend: run.probe.backend, backendVersion: run.probe.version, startedAt, endedAt: now(), failure, exitCode, outputSha256, error,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
}

/** A failed record whose reviewer could not start here carries its reason into run and status output. */
function recordReasonLines(record: FailedRecord): string[] {
  if (record.reasonCode === undefined) return [];
  return reasonLines([{ backend: record.backend, code: record.reasonCode as UnavailableReason["code"], detail: record.error }]);
}

const lockLost = (): SetupReviewResult => ({
  stdout: lines("Setup review: this run lost its lock on the setup before publishing; nothing was published.") + STOP,
  exitCode: SETUP_REVIEW_EXIT.lock,
});

const storageFailure = (detail: string): SetupReviewResult => ({
  stdout: lines(`Setup review: the review could not be stored (${detail}); no verdict is available.`) + STOP,
  exitCode: SETUP_REVIEW_EXIT.storage,
});

/** Publishes a failed record. Returns the result to print once it is published. */
function publishFailure(run: StagedRun, record: FailedRecord, writeRecord: (path: string, data: string) => void): SetupReviewResult {
  if (record.outputSha256 === null) rmSync(join(run.staging, "reviewer-output.json"), { force: true });
  writeRecord(join(run.staging, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (publishStaged(run) === "lock-lost") return lockLost();
  return {
    stdout: lines(probeLine(run.probe), failedLine(record.revisionSha256, record.recordId), ...recordReasonLines(record), `Setup review: the reviewer failed (${record.failure}): ${record.error}`) + STOP,
    exitCode: SETUP_REVIEW_EXIT.failed,
  };
}

async function reviewStaged(run: StagedRun, newCycleReason: string | null, round: number): Promise<SetupReviewResult> {
  const timeoutMs = run.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const writeOutput = run.deps.writeOutput ?? ((p: string, d: Buffer) => writeFileSynced(p, d));
  const writeRecord = run.deps.writeRecord ?? ((p: string, d: string) => writeFileSynced(p, d));
  const backend = run.probe.backend;
  const prompt = Buffer.concat([Buffer.from(REVIEW_PROMPT), run.packet.bytes]).toString("utf-8");

  writeFileSynced(join(run.staging, "packet.md"), run.packet.bytes);
  const work = join(run.staging, ".work");
  mkdirSync(work, { mode: 0o700 });
  const schemaJson = JSON.stringify(SETUP_REVIEW_SCHEMA);
  const outFile = join(work, "codex-output.json");
  let args: string[];
  if (backend === "codex") {
    writeFileSynced(join(work, "schema.json"), schemaJson);
    args = codexArgs(join(work, "schema.json"), outFile);
  } else {
    args = claudeArgs(schemaJson);
  }

  if (!verifyProjectLockOwnership(run.lock)) return lockLost();
  // ISS-1457: the probe checked its own folder; the review's folder is checked the same way before the reviewer starts.
  const location = checkExecLocation(run.staging, storeRoot(run.env), run.env, repositoryBoundary(run.cwd));
  const codexHome = backend === "codex" ? checkCodexHome(run.env, run.cwd) : null;
  const refusal = !location.ok ? `untrusted location: ${location.detail}` : codexHome && !codexHome.ok ? `untrusted CODEX_HOME: ${codexHome.reason.detail}` : null;
  const startedAt = now();
  if (refusal) {
    rmSync(work, { recursive: true, force: true });
    return publishFailure(run, failedRecord(run, startedAt, "spawn", null, null, refusal, codexHome && !codexHome.ok ? "untrusted-codex-home" : "untrusted-location"), writeRecord);
  }
  const childEnv = codexHome?.ok ? { ...run.env, CODEX_HOME: codexHome.codexHome } : run.env;
  // ISS-1457: the reviewer runs only under the supervisor, which stops its whole group even if this process dies.
  const result = await runSupervised(backend, args, { cwd: run.staging, env: reviewerEnv(backend, childEnv), input: prompt, timeoutMs, ...(run.deps.killGraceMs !== undefined ? { killGraceMs: run.deps.killGraceMs } : {}) });

  let raw: Buffer | null = null;
  let failure: { kind: FailureKind; error: string; reasonCode?: string } | null = null;
  const fatal = backend === "codex" && result.exitCode !== 0 ? fatalStartLine(result.stderr) : null;
  const stderrNote = result.truncated.stderr ? ` (stderr past ${RELAY_CAP_BYTES} bytes was dropped)` : "";
  if (result.supervisorUnresponsive) failure = { kind: "spawn", error: `the reviewer's supervisor failed: ${result.supervisorError}`, reasonCode: "supervisor-unresponsive" };
  else if (result.supervisorError !== null) failure = { kind: "spawn", error: `the reviewer's supervisor failed: ${result.supervisorError}`, reasonCode: "supervisor-failed" };
  else if (result.spawnError !== null) failure = { kind: "spawn", error: result.spawnError };
  else if (result.cleanup === "unconfirmed") failure = { kind: "exit", error: `cleanup-unconfirmed: ${result.cleanupDetail ?? "the reviewer's group was not seen gone"}` };
  // ISS-1457: the verdict channel has an explicit limit, checked before anything is parsed.
  else if (result.truncated.stdout) failure = { kind: "exit", error: `the reviewer wrote more than ${STDOUT_LIMIT_BYTES} bytes on stdout, the limit for an answer`, reasonCode: "reviewer-output-limit" };
  // ISS-1456: a start the sandbox denied after the probe passed is a reviewer that could not start, never a review.
  else if (fatal) failure = { kind: "exit", error: `cannot start inside this sandbox (${fatal})`, reasonCode: "sandbox-start-denied" };
  else if (result.timedOut) failure = { kind: "timeout", error: `no answer within ${Math.round(timeoutMs / 1000)} seconds` };
  else if (result.exitCode !== 0) failure = { kind: "exit", error: `exited with status ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""}${stderrNote}` };
  else if (backend === "codex") {
    try {
      raw = readFileSync(outFile);
    } catch {
      failure = { kind: "schema-invalid", error: "the reviewer wrote no answer" };
    }
  } else {
    raw = result.stdout;
  }
  rmSync(work, { recursive: true, force: true });

  try {
    if (failure) return publishFailure(run, failedRecord(run, startedAt, failure.kind, result.exitCode, null, failure.error, failure.reasonCode), writeRecord);

    const outputSha256 = sha256(raw!);
    try {
      writeOutput(join(run.staging, "reviewer-output.json"), raw!);
    } catch (e) {
      try {
        publishFailure(run, failedRecord(run, startedAt, "persist", 0, null, `the answer could not be stored: ${(e as Error).message}`), writeRecord);
      } catch {
        /* the failed record could not be kept either; the stop below stands */
      }
      return storageFailure((e as Error).message);
    }

    let answer: SetupReviewAnswer;
    try {
      answer = parseReviewerOutput(backend, raw!);
    } catch (e) {
      return publishFailure(run, failedRecord(run, startedAt, "schema-invalid", 0, outputSha256, `the answer is outside the schema: ${(e as Error).message}`), writeRecord);
    }

    const record: CompletedRecord = {
      state: "completed", recordId: run.recordId, setupId: run.setup.setupId, cycle: run.setup.cycle, round,
      revisionSha256: run.packet.revisionSha256, sectionSha256s: run.packet.sectionSha256s, backend, backendVersion: run.probe.version,
      startedAt, endedAt: now(), exitCode: 0, outputSha256, verdict: answer.verdict, findingsCount: answer.findings.length,
      reviewerSessionId: answer.sessionId ?? null, newCycleReason,
    };
    try {
      writeRecord(join(run.staging, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
    } catch (e) {
      try {
        publishFailure(run, failedRecord(run, startedAt, "persist", 0, outputSha256, `the record could not be stored: ${(e as Error).message}`), writeRecord);
      } catch {
        /* as above */
      }
      return storageFailure((e as Error).message);
    }
    // The reviewer ran inside the staging directory: the packet it leaves must still be the packet it was given.
    let stagedPacket: string | null = null;
    try {
      stagedPacket = sha256(readFileSync(join(run.staging, "packet.md")));
    } catch {
      /* a missing packet is a changed one */
    }
    if (stagedPacket !== run.packet.revisionSha256) {
      writeFileSynced(join(run.staging, "packet.md"), run.packet.bytes);
      return publishFailure(run, failedRecord(run, startedAt, "persist", 0, outputSha256, "the stored packet changed during the review"), writeRecord);
    }
    const unsynced = failedRecord(run, startedAt, "persist", 0, outputSha256, "the published record could not be made durable");
    if (publishStaged(run, unsynced) === "lock-lost") return lockLost();
    const findings = answer.findings.map((f) => `- ${f.severity}, ${f.requirement}: ${f.description}`);
    return { stdout: lines(probeLine(run.probe), completedLine(record), ...findings), exitCode: SETUP_REVIEW_EXIT.ok };
  } catch (e) {
    return storageFailure((e as Error).message);
  }
}

export async function handleSetupReviewRun(io: SetupReviewIo, opts: SetupReviewRunOptions): Promise<SetupReviewResult> {
  let paths: SetupPaths;
  let setup: SetupState;
  let packet: ReviewPacket;
  try {
    paths = setupPaths(io.env, io.cwd, opts.setup);
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }
  // The store check comes before the setup is placed, so a store that cannot be written is exit 3
  // with no placement writes, never a storage failure from the move.
  const store = preflightStore(storeRoot(io.env));
  if (store.kind === "unwritable") {
    return { stdout: lines(probeLine(null), ...reasonLines(storeUnwritable(store.reason, io.env))) + STOP, exitCode: SETUP_REVIEW_EXIT.failed };
  }
  if (store.kind === "error") return storageFailure(`the review store is not writable: ${store.error.message}`);
  const placedForRun = await placeOrRefuse(paths, io.env, false);
  if (placedForRun) return placedForRun;
  try {
    setup = readSetup(paths);
    if (opts.newCycle && !(opts.reason ?? "").trim()) throw new SetupReviewUsageError("--new-cycle needs --reason with the owner's adjustment.");
    if (opts.backend !== undefined && !SETUP_REVIEW_BACKENDS.includes(opts.backend)) throw new SetupReviewUsageError(`unknown backend "${opts.backend}"; use codex or claude.`);
    packet = parsePacket(io.stdin());
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }

  let outcome: ProbeOutcome;
  try {
    outcome = await probeAll(io.env, io.cwd, io.deps, opts.backend);
  } catch (e) {
    return storageFailure(`the start check could not run: ${(e as Error).message}`);
  }
  const probe = outcome.probe;
  if (!probe && opts.backend !== undefined) {
    return { stdout: lines(`Setup review: the ${opts.backend} reviewer cannot start here; run without --backend to use whichever can.`, ...reasonLines(outcome.reasons)), exitCode: SETUP_REVIEW_EXIT.usage };
  }
  if (!probe) return { stdout: lines(probeLine(null), ...reasonLines(outcome.reasons)) + STOP, exitCode: SETUP_REVIEW_EXIT.failed };

  const recordId = newId("SR");
  const staging = join(paths.records, `.staging-${recordId}`);
  try {
    mkdirSync(paths.records, { recursive: true, mode: 0o700 });
    storagePreflight(staging);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return storageFailure(`the review store is not writable: ${(e as Error).message}`);
  }

  let lock: ProjectLockHandle;
  try {
    lock = await acquireProjectLockAsync(paths.lock, LOCK_WAIT);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return lockBusy();
  }
  try {
    removeStaleStaging(paths, staging);
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      persistRevision(paths, packet);
      setup = readSetup(paths);
    } catch (e) {
      const u = asUsage(e);
      if (u) return u;
      return storageFailure((e as Error).message);
    }
    const records = loadRecords(paths);
    let newCycleReason: string | null = null;
    if (opts.newCycle) {
      if (completedInCycle(records, setup.cycle).length === 0) {
        return usage("a new cycle needs a completed review in the current cycle; run without --new-cycle.");
      }
      const reason = opts.reason!.trim();
      setup = { ...setup, cycle: setup.cycle + 1, cycleReasons: { ...setup.cycleReasons, [String(setup.cycle + 1)]: reason } };
      try {
        writeSetup(paths, setup);
      } catch (e) {
        return storageFailure((e as Error).message);
      }
      newCycleReason = reason;
    }
    const done = completedInCycle(records.filter((r) => r.kind === "valid"), setup.cycle).length;
    if (done >= ROUNDS_PER_CYCLE) {
      return {
        stdout: lines(`Setup review: the round limit is reached (${ROUNDS_PER_CYCLE} reviews in this cycle); no reviewer was started. Run status for the package's review lines, or ask the owner before a new cycle.`),
        exitCode: SETUP_REVIEW_EXIT.roundLimit,
      };
    }
    const run: StagedRun = { paths, packet, setup, probe, recordId, staging, deps: io.deps, lock, env: io.env, cwd: io.cwd };
    return await reviewStaged(run, newCycleReason, done + 1);
  } finally {
    releaseProjectLock(lock);
  }
}

// --- status -------------------------------------------------------------------

export async function handleSetupReviewStatus(io: SetupReviewIo, opts: { setup: string; skipped?: boolean }): Promise<SetupReviewResult> {
  let paths: SetupPaths;
  let setup: SetupState;
  try {
    paths = setupPaths(io.env, io.cwd, opts.setup);
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }
  // ISS-1456: a skip the store cannot hold is still the owner's answer; it is printed, written nowhere.
  // Any other storage failure is exit 6, before the setup is read.
  // A plain status on a store it cannot write reads a setup already in place and moves nothing:
  // one that would have to be moved is exit 3, before any placement write.
  const store = preflightStore(storeRoot(io.env));
  // A store check that failed other than as unwritable is exit 6 for every status, before any placement or read.
  if (store.kind === "error") return storageFailure(`the review store is not writable: ${store.error.message}`);
  if (opts.skipped) {
    if (store.kind === "unwritable") return { stdout: lines(probeLine(null), SKIPPED_LINE, NOT_RECORDED), exitCode: SETUP_REVIEW_EXIT.ok };
  } else if (store.kind === "unwritable" && !setupInPlace(paths, io.env)) {
    return { stdout: lines(probeLine(null), ...reasonLines(storeUnwritable(store.reason, io.env))) + STOP, exitCode: SETUP_REVIEW_EXIT.failed };
  }
  const placedForStatus = store.kind === "unwritable" ? null : await placeOrRefuse(paths, io.env, false);
  if (placedForStatus) return placedForStatus;
  try {
    setup = readSetup(paths);
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }

  if (opts.skipped) {
    let skipped: SetupState | null;
    try {
      skipped = await updateSetupLocked(paths, (current) => ({ ...(current ?? readSetup(paths)), skipped: { at: now() } }));
    } catch (e) {
      const u = asUsage(e);
      if (u) return u;
      return storageFailure((e as Error).message);
    }
    if (!skipped) return lockBusy();
    return { stdout: lines(probeLine(skipped.probe), SKIPPED_LINE), exitCode: SETUP_REVIEW_EXIT.ok };
  }

  let packet: ReviewPacket;
  try {
    packet = parsePacket(io.stdin());
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }
  // Under the run lock: a record a run has renamed in but not yet synced is never read as published.
  // ISS-1457 round 3: a store that denies writes holds no run that could be renaming one in, so a status
  // there reads without the lock. The lock is reported busy only when it is held: its own wait or legacy
  // refusal, which carries no cause. A permission error taking it (the store check passed, the setup folder
  // denies writes) is the same unwritable case; any other failure is exit 6 naming it. The residual: a run
  // that held the lock before the store went read-only may be mid-rename until its own writes fail.
  let lock: ProjectLockHandle | null = null;
  const lockless = store.kind === "unwritable";
  if (!lockless) {
    try {
      lock = await (io.deps.acquireStatusLock ?? acquireProjectLockAsync)(paths.lock, LOCK_WAIT);
    } catch (e) {
      const cause = (e as { cause?: unknown }).cause;
      if (cause === undefined) return lockBusy();
      const code = (cause as NodeJS.ErrnoException).code;
      if (!(code && UNWRITABLE.has(code))) return storageFailure(`the run lock could not be taken (${code ?? (cause as Error).message ?? String(cause)})`);
    }
  }
  try {
    try {
      setup = readSetup(paths);
    } catch (e) {
      const u = asUsage(e);
      if (u) return u;
      throw e;
    }
    io.deps.beforeStatusClassify?.();
    return statusLines(paths, setup, packet);
  } finally {
    if (lock) releaseProjectLock(lock);
  }
}

function statusLines(paths: SetupPaths, setup: SetupState, packet: ReviewPacket): SetupReviewResult {
  try {
    persistRevision(paths, packet);
  } catch (e) {
    return storageFailure(`the revision could not be kept: ${(e as Error).message}`);
  }

  const c = classify(loadRecords(paths), packet.revisionSha256, setup.cycle);
  switch (c.kind) {
    case "unreadable":
      return { stdout: lines(probeLine(c.record ? probeOf(c.record) : setup.probe), unreadableLine(c.recordId)) + STOP, exitCode: SETUP_REVIEW_EXIT.unreadable };
    case "completed":
      return { stdout: lines(probeLine(probeOf(c.record)), completedLine(c.record), revisionLine(packet.revisionSha256)), exitCode: SETUP_REVIEW_EXIT.ok };
    case "round-limit":
      return { stdout: lines(probeLine(probeOf(c.last)), roundLimitLine(packet.revisionSha256, c.last), revisionLine(packet.revisionSha256)), exitCode: SETUP_REVIEW_EXIT.ok };
    case "failed":
      return { stdout: lines(probeLine(probeOf(c.record)), failedLine(packet.revisionSha256, c.record.recordId), ...recordReasonLines(c.record)) + STOP, exitCode: SETUP_REVIEW_EXIT.failed };
    case "absent":
      return {
        stdout: lines(probeLine(setup.probe), absentLine(packet.revisionSha256), ...(setup.probe === null && setup.unavailable ? reasonLines(setup.unavailable.reasons) : [])),
        exitCode: SETUP_REVIEW_EXIT.absent,
      };
  }
}
