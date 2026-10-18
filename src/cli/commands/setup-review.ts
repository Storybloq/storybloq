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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireProjectLockAsync, releaseProjectLock, verifyProjectLockOwnership, type ProjectLockHandle } from "../../core/project-lock.js";
import {
  absentLine, classify, completedInCycle, completedLine, failedLine, fsyncDir, loadRecords, parsePacket, persistRevision,
  probeLine, probeOf, readSetup, revisionLine, roundLimitLine, ROUNDS_PER_CYCLE, setupPaths, SetupReviewUsageError, sha256,
  SKIPPED_LINE, STOP_LINES, storeRoot, unreadableLine, writeFileDurable, writeFileSynced,
  type CompletedRecord, type FailedRecord, type FailureKind, type ProbeResult, type ReviewPacket, type SetupPaths, type SetupState,
} from "../../core/setup-review.js";
import {
  claudeArgs, codexArgs, parseReviewerOutput, probeBackend, reviewerEnv, runReviewer, SETUP_REVIEW_BACKENDS, SETUP_REVIEW_SCHEMA,
  type SetupReviewAnswer, type SetupReviewBackend,
} from "../../core/setup-review-backends.js";

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

async function probeAll(env: NodeJS.ProcessEnv): Promise<ProbeResult | null> {
  for (const backend of SETUP_REVIEW_BACKENDS) {
    const version = await probeBackend(backend, env);
    if (version !== null) return { backend, version };
  }
  return null;
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

// --- gate ---------------------------------------------------------------------

export async function handleSetupReviewGate(io: SetupReviewIo, opts: { setup?: string }): Promise<SetupReviewResult> {
  let paths: SetupPaths;
  try {
    paths = setupPaths(io.env, io.cwd, opts.setup ?? newId("SS"));
    if (opts.setup !== undefined) readSetup(paths);
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }
  const probe = await probeAll(io.env);
  let setup: SetupState | null;
  try {
    mkdirSync(storeRoot(io.env), { recursive: true, mode: 0o700 });
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    setup = await updateSetupLocked(paths, (current) => {
      if (opts.setup !== undefined && current === null) readSetup(paths);
      const base = current ?? { setupId: paths.setupId, projectKey: paths.projectKey, createdAt: now(), cycle: 1, cycleReasons: {}, probe: null, probedAt: now() };
      return { ...base, probe, probedAt: now() };
    });
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    return { stdout: lines(`Setup review: the review store cannot be written (${(e as Error).message}).`) + STOP, exitCode: SETUP_REVIEW_EXIT.storage };
  }
  if (!setup) return lockBusy();
  const head = lines(`Setup id: ${setup.setupId}`, probeLine(probe));
  if (!probe) return { stdout: head + lines(UNAVAILABLE_INSTRUCTION, "") + STOP, exitCode: SETUP_REVIEW_EXIT.ok };
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

function failedRecord(run: StagedRun, startedAt: string, failure: FailureKind, exitCode: number | null, outputSha256: string | null, error: string): FailedRecord {
  return {
    state: "failed", recordId: run.recordId, setupId: run.setup.setupId, cycle: run.setup.cycle, revisionSha256: run.packet.revisionSha256,
    backend: run.probe.backend, backendVersion: run.probe.version, startedAt, endedAt: now(), failure, exitCode, outputSha256, error,
  };
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
    stdout: lines(probeLine(run.probe), failedLine(record.revisionSha256, record.recordId), `Setup review: the reviewer failed (${record.failure}): ${record.error}`) + STOP,
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
  const startedAt = now();
  const result = await runReviewer(backend, args, { cwd: run.staging, env: reviewerEnv(backend, run.env), input: prompt, timeoutMs, ...(run.deps.killGraceMs !== undefined ? { killGraceMs: run.deps.killGraceMs } : {}) });

  let raw: Buffer | null = null;
  let failure: { kind: FailureKind; error: string } | null = null;
  if (result.spawnError !== null) failure = { kind: "spawn", error: result.spawnError };
  else if (result.timedOut) failure = { kind: "timeout", error: `no answer within ${Math.round(timeoutMs / 1000)} seconds` };
  else if (result.exitCode !== 0) failure = { kind: "exit", error: `exited with status ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""}` };
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
    if (failure) return publishFailure(run, failedRecord(run, startedAt, failure.kind, result.exitCode, null, failure.error), writeRecord);

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
    setup = readSetup(paths);
    if (opts.newCycle && !(opts.reason ?? "").trim()) throw new SetupReviewUsageError("--new-cycle needs --reason with the owner's adjustment.");
    if (opts.backend !== undefined && !SETUP_REVIEW_BACKENDS.includes(opts.backend)) throw new SetupReviewUsageError(`unknown backend "${opts.backend}"; use codex or claude.`);
    packet = parsePacket(io.stdin());
  } catch (e) {
    const u = asUsage(e);
    if (u) return u;
    throw e;
  }

  let probe: ProbeResult | null;
  if (opts.backend !== undefined) {
    const version = await probeBackend(opts.backend, io.env);
    if (version === null) return usage(`the ${opts.backend} reviewer cannot start here; run without --backend to use whichever can.`);
    probe = { backend: opts.backend, version };
  } else {
    probe = await probeAll(io.env);
  }
  if (!probe) return { stdout: lines(probeLine(null)) + STOP, exitCode: SETUP_REVIEW_EXIT.failed };

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
    const run: StagedRun = { paths, packet, setup, probe, recordId, staging, deps: io.deps, lock, env: io.env };
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
  let lock: ProjectLockHandle;
  try {
    lock = await acquireProjectLockAsync(paths.lock, LOCK_WAIT);
  } catch {
    return lockBusy();
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
    releaseProjectLock(lock);
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
      return { stdout: lines(probeLine(probeOf(c.record)), failedLine(packet.revisionSha256, c.record.recordId)) + STOP, exitCode: SETUP_REVIEW_EXIT.failed };
    case "absent":
      return { stdout: lines(probeLine(setup.probe), absentLine(packet.revisionSha256)), exitCode: SETUP_REVIEW_EXIT.absent };
  }
}
