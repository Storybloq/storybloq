/**
 * T-538 S3a-2: `storybloq setup-verify`, the only writer of an establishment
 * ticket's verification result and its completion. It runs the component's
 * test command, reads the evidence from the whole stream, and on a verified
 * run completes the ticket, marks the component's test stage verified in the
 * setup verification record and turns on the recipe stages it serves, all in
 * one transaction.
 *
 * The run sits between two holds of the project lock. The first checks
 * everything and takes a digest; the command runs outside the lock; the
 * second checks everything again and writes only when the digest is the same.
 *
 * The same command records the owner's answer to an unreadable run, in one
 * hold: an adapter (an argv the next run uses, and the inherited variables it
 * drops), leave-off (the ticket closes, the component is left off, the stages
 * stay as they are) or stop (the decision only). `--reopen` reopens a ticket
 * closed without a result by a writer outside the guard.
 *
 * Exit codes: 0 verified or recorded; 1 failed or no tests; 2 refused; 4
 * evidence unreadable; 5 stale, or the process group's cleanup unconfirmed.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  invalidateResolutionWriteContext,
  prepareConfigWrite,
  prepareTicketWrite,
  runTransactionUnlocked,
  withProjectLock,
} from "./project-loader.js";
import { localDateOf } from "./local-date.js";
import { displayIdOf } from "./resolver.js";
import { checkpointState, hasOwnerCheckpoint } from "./owner-checkpoint.js";
import { describeCheckpointBlock, prepareCompletionWrite } from "./checkpoint-evidence.js";
import { authoriseStatusChange, collectCompletionOwnership, CompletionOwnershipUnavailable } from "./status-authority.js";
import type { CompletionGuardOptions } from "./claims.js";
import { parseSetupMeta, VERIFICATION_DROPPABLE, type AdapterDecision, type BuildSpec, type EstablishableStage, type ParsedSetupMeta, type SetupItemMeta, type TestSpec, type VerificationDecision, type VerificationDroppable } from "./setup-meta.js";
import { VERIFICATION_RESULT_AUTHORITY } from "./setup-verification-guard.js";
import { readRecord, recordActivation, type RecordComponent, type SetupVerificationRecord } from "./setup-verification-record.js";
import { establishStage, SERVES, type StagesConfig } from "./verification-activation.js";
import { allKeyed, ambiguityLine } from "./setup-apply.js";
import { KILL_GRACE_MS, ownedGroupUnsupported, runInGroup, runOwnedGroup } from "./process-group.js";
import { classifyEvidence, EvidenceScanner, tailDigest, type Evidence, type TestRunner } from "./setup-verify-parsers.js";
import type { ProjectState } from "./project-state.js";
import type { Config } from "../models/config.js";
import type { Ticket } from "../models/ticket.js";

export type SetupVerifyExitCode = 0 | 1 | 2 | 4 | 5;

export interface SetupVerifyResult {
  readonly exitCode: SetupVerifyExitCode;
  readonly lines: string[];
}

export type VerificationResolution = "adapter" | "leave-off" | "stop";

export interface SetupVerifyInput {
  readonly ticket: string;
  /** The owner's answer to an unreadable run; `ownerWords` is required with it. */
  readonly resolve?: VerificationResolution;
  readonly argv?: readonly string[];
  readonly drop?: readonly string[];
  readonly ownerWords?: string;
  /** The run a resolution answers: the 16 hex its stopped run printed. */
  readonly run?: string;
  readonly reopen?: boolean;
}

export interface SetupVerifyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly lockDeadlineMs?: number;
}

/** Test seam: runs between the command's end and the second lock hold. Not reachable through any CLI or MCP input. */
export const setupVerifySeams: { afterRun: () => void | Promise<void> } = {
  afterRun: () => {},
};

/** How many of the kept tail's last lines a failed or unreadable run prints. */
const TAIL_LINES = 40;

class Refusal extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
  }
}

const refuse = (why: string): Refusal => new Refusal([`Setup-verify refused: ${why}`]);

type Meta = SetupItemMeta & { readonly verification: NonNullable<SetupItemMeta["verification"]>; readonly establishes: NonNullable<SetupItemMeta["establishes"]> };

/** A component's evidence for one stage in the record, or null when the plan has none. */
function stageOf(c: RecordComponent, stage: EstablishableStage): { readonly status: string } | null {
  return stage === "test" ? c.test : stage === "build" ? c.build : c.verify;
}

/** Everything the first hold established, and the digest the second hold must reproduce. */
interface Checked {
  readonly ticket: Ticket;
  readonly meta: Meta;
  readonly record: SetupVerificationRecord;
  readonly component: RecordComponent;
  readonly guard: CompletionGuardOptions;
  /** The workdir's real path, where the command runs. */
  readonly workdir: string;
  readonly digest: string;
  /** What a later --resolve names the run by: see `runToken`. */
  readonly token: string;
}

const label = (t: Ticket): string => displayIdOf(t);

function findTicket(state: ProjectState, ref: string): Ticket {
  const r = state.resolveTicketRef(ref);
  if (r.kind === "found") return r.item;
  if (r.kind === "ambiguous") throw refuse(`${ref} names more than one ticket.`);
  throw refuse(`no ticket ${ref} in this project.`);
}

/**
 * The prerequisite closure: every ticket the target waits on, transitively.
 * Each reference must resolve and release (an owner checkpoint by approval or
 * retirement, any other ticket by completion); a checkpoint's own blockers are
 * its rules' business, so the walk stops at one.
 */
function closure(state: ProjectState, target: Ticket): Ticket[] {
  const seen = new Map<string, Ticket>();
  const walk = (t: Ticket): void => {
    for (const ref of t.blockedBy) {
      const r = state.resolveTicketRef(ref);
      if (r.kind !== "found") throw refuse(`${label(t)} waits on ${ref}, which ${r.kind === "ambiguous" ? "names more than one ticket" : "is not in this project"}.`);
      if (seen.has(r.item.id)) continue;
      seen.set(r.item.id, r.item);
      if (!state.releasesDependency(r.item)) {
        throw refuse(hasOwnerCheckpoint(r.item)
          ? describeCheckpointBlock(label(target), [label(r.item)])
          : `${label(target)} waits on ${label(r.item)}, which is not complete.`);
      }
      if (!hasOwnerCheckpoint(r.item)) walk(r.item);
    }
  };
  walk(target);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function servedStages(config: Config, stage: EstablishableStage): Record<string, unknown> {
  const stages = (config as Config & { recipeOverrides?: { stages?: Record<string, unknown> } }).recipeOverrides?.stages ?? {};
  return Object.fromEntries(SERVES[stage].map((s) => [s, stages[s] ?? null]));
}

const outside = (rel: string): boolean => rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);

/** The real path of `p`: its longest existing ancestor resolved through every symlink, with the missing rest appended. */
function realOf(p: string): string {
  const rest: string[] = [];
  let head = p;
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    const parent = dirname(head);
    if (parent === head) return p;
    rest.push(basename(head));
    head = parent;
  }
}

/**
 * The workdir's real path inside the project, or a refusal. Containment is
 * checked on real paths, so a symlink in the workdir that points outside the
 * project is refused; the command then runs in the real path checked.
 */
export function workdirOf(root: string, workdir: string): string {
  const abs = resolve(root, workdir);
  if (outside(relative(root, abs))) throw refuse(`the workdir ${workdir} is outside the project.`);
  const real = realOf(abs);
  if (outside(relative(realOf(root), real))) throw refuse(`the workdir ${workdir} resolves outside the project (${real}).`);
  return real;
}

/**
 * Every check a run needs, under the lock. A refusal throws; otherwise the
 * digest covers what the run and its result depend on: the ticket's id, setup
 * and key, the workdir's real path, the spec, the ticket's status and claims,
 * the closure's ids, statuses, edges and checkpoint states, the record, the
 * two served stages, the decision, the ownership evidence and the environment
 * the command runs with.
 */
interface Identified {
  readonly ticket: Ticket;
  readonly meta: Meta;
  readonly record: SetupVerificationRecord;
  readonly component: RecordComponent;
}

/**
 * What every operation checks first: the ticket is an establishment ticket,
 * no setup is unfinished, it is the unique non-superseded owner of its key,
 * and its spec matches the record's component.
 */
function identify(state: ProjectState, ref: string): Identified {
  const ticket = findTicket(state, ref);
  const parsed = parseSetupMeta("ticket", ticket);
  if (parsed.kind === "invalid") throw refuse(`${label(ticket)}'s setup field does not read: ${parsed.reason}.`);
  if (parsed.kind !== "item" || parsed.meta.establishes === undefined || parsed.meta.verification === undefined) {
    throw refuse(`${label(ticket)} is not an establishment ticket; setup-verify runs only on a ticket a setup created to establish a test stage.`);
  }
  if (parsed.meta.verification.spec.stage === "verify") {
    throw refuse(`${label(ticket)} establishes the verify stage; this CLI runs setup-verify only for a test or build stage.`);
  }
  const meta = parsed.meta as Meta;
  const spec = meta.verification.spec;

  if (state.setupInProgress.some((s) => s.setupId === meta.setupId)) {
    throw new Refusal([`Setup refused: finish or stop the setup first: storybloq setup-apply --setup ${meta.setupId} --resume`]);
  }
  if (meta.supersededBy !== undefined) throw refuse(`${label(ticket)} was superseded by ${meta.supersededBy}; its key ${meta.key} belongs to that ticket.`);
  const owners = allKeyed(state, meta.setupId, meta.key);
  if (owners.length !== 1 || owners[0]!.id !== ticket.id) {
    throw refuse(`${label(ticket)} is not the only active item with setup key ${meta.key} (${owners.map((o) => displayIdOf(o)).join(", ")}).`);
  }

  const read = readRecord(state.config);
  if (read.kind === "absent") throw refuse("this project's config has no setup verification record (.story/config.json setupVerification); it predates setup-verify.");
  if (read.kind === "invalid") throw refuse(`the setup verification record in .story/config.json does not read: ${read.reason}.`);
  const record = read.record;
  if (record.setupId !== meta.setupId) throw refuse(`the setup verification record belongs to setup ${record.setupId}, not ${meta.setupId}.`);
  const component = record.components.find((c) => c.id === spec.component);
  if (!component || stageOf(component, spec.stage) === null) throw refuse(`the setup verification record has no ${spec.stage} stage for component ${spec.component}.`);
  const common = [
    ["component", meta.establishes.component, spec.component],
    ["workdir", component.workdir, spec.workdir],
  ] as const;
  const own: ReadonlyArray<readonly [string, unknown, unknown]> = spec.stage === "test"
    ? [["command", component.test!.command, spec.command], ["runner", component.test!.runner, spec.runner], ["wrapper", component.test!.wrapper, spec.wrapper]]
    : spec.stage === "build"
      ? [["command", component.build!.command, spec.command]]
      : [["command", component.verify!.startCommand, spec.command]];
  const mismatch = [...common, ...own].find(([, a, b]) => a !== b);
  if (mismatch) throw refuse(`${label(ticket)}'s verification spec and the setup verification record disagree on the ${mismatch[0]} of ${spec.component} (${String(mismatch[2])} against ${String(mismatch[1])}).`);
  return { ticket, meta, record, component };
}

/** A component already verified or left off is terminal, whichever ticket asks; so is a ticket that is complete. */
function assertOpen({ ticket, meta, component }: Identified): void {
  const { stage } = meta.verification.spec;
  const status = stageOf(component, stage)!.status;
  if (status === "verified" || status === "left-off") {
    throw refuse(`${meta.verification.spec.component}'s ${stage} stage is already ${status === "verified" ? "verified" : "left off"}.`);
  }
  if (ticket.status === "complete") {
    throw refuse(meta.verification.result
      ? `${label(ticket)} is already ${meta.verification.result.status === "verified" ? "verified" : "left off"}.`
      : `${label(ticket)} is complete without a verification result; reopen it with storybloq setup-verify --ticket ${label(ticket)} --reopen.`);
  }
}

async function ownership(root: string): Promise<CompletionGuardOptions> {
  try {
    return await collectCompletionOwnership(root);
  } catch (err) {
    if (!(err instanceof CompletionOwnershipUnavailable)) throw err;
    throw refuse(`ownership cannot be verified: ${err.unreadable ? err.message : `the session store (.story/sessions) could not be read (${err.message}).`}`);
  }
}

/** Whether this caller may complete the ticket: the authority a run, an adapter, leave-off and stop all need. */
function assertMayComplete(ticket: Ticket, guard: CompletionGuardOptions): void {
  const decision = authoriseStatusChange(ticket, { ...ticket, status: "complete" } as Ticket, guard, { claimFreeReopen: false }, label(ticket));
  if (!decision.ok) throw refuse(decision.reason);
}

async function check(root: string, state: ProjectState, ref: string, env: Readonly<Record<string, string>>): Promise<Checked> {
  const found = identify(state, ref);
  assertOpen(found);
  const { ticket, meta, record, component } = found;
  const spec = meta.verification.spec;
  const workdir = workdirOf(root, spec.workdir);
  const prerequisites = closure(state, ticket);
  const guard = await ownership(root);
  assertMayComplete(ticket, guard);

  const fields = {
    id: ticket.id,
    setupId: meta.setupId,
    key: meta.key,
    workdir,
    spec,
    status: ticket.status,
    claim: ticket.claim ?? null,
    claimedBySession: ticket.claimedBySession ?? null,
    blockedBy: ticket.blockedBy,
    closure: prerequisites.map((t) => ({ id: t.id, status: t.status, blockedBy: t.blockedBy, checkpoint: checkpointState(t) })),
    record,
    stages: servedStages(state.config, spec.stage),
    decision: meta.verification.decision ?? null,
    guard,
  };
  const digest = stageDigest(spec.stage, { ...fields, env });
  return { ticket, meta, record, component, guard, workdir, digest, token: runToken(stageDigest(spec.stage, { ...fields, env: tokenEnv(env) })) };
}

/**
 * One canonical digest per stage (T-538 S3b): what a run and every outcome
 * written after it depend on. The second hold of a run must reproduce it, and
 * a resolution must reproduce the token of the run it answers.
 */
export function stageDigest(stage: EstablishableStage, fields: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify({ stage, ...fields })).digest("hex");
}

/** The first 16 hex of a stage digest: printed by every outcome a resolution may answer, and required back with --run. */
export function runToken(digest: string): string {
  return digest.slice(0, 16);
}

/**
 * The variables a run token binds: the ones setup-verify sets or reads for
 * its evidence. The rest of the caller's environment differs between any two
 * shells, so a resolution from a later shell could never name the run; the
 * run's own second hold still binds the whole environment.
 */
const TOKEN_ENV = ["CI", "NO_COLOR", "FORCE_COLOR", "PYTEST_ADDOPTS", "GOFLAGS"] as const;

function tokenEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(TOKEN_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]!]));
}

/**
 * The environment a test run gets, and the same with the report path as a
 * placeholder for the digest; or why the inherited options cannot coexist
 * with the evidence. A resolution computes it with the placeholder as the
 * path, which gives the run's digest environment.
 */
function runEnvironment(meta: ParsedSetupMeta, base: NodeJS.ProcessEnv, junitPath: string): { env: Record<string, string> | null; digestEnv: Record<string, string>; incompatible: string | null } {
  const spec = meta.kind === "item" ? meta.meta.verification?.spec : undefined;
  if (spec !== undefined && spec.stage !== "test") {
    const env = plainEnv(base);
    return { env, digestEnv: env, incompatible: null };
  }
  const runner = spec?.stage === "test" ? spec.runner : undefined;
  const adapter = meta.kind === "item" ? meta.meta.verification?.decision?.adapter : undefined;
  const built = runner === undefined ? { env: {} } : evidenceEnv(runner, withoutDropped(base, adapter), junitPath);
  if ("incompatible" in built) return { env: null, digestEnv: {}, incompatible: built.incompatible };
  const env = built.env;
  // The report path differs on every run, so the digest reads it as a placeholder.
  const digestEnv = { ...env, ...(env.PYTEST_ADDOPTS === undefined ? {} : { PYTEST_ADDOPTS: env.PYTEST_ADDOPTS.replace(junitPath, "<report>") }) };
  return { env, digestEnv, incompatible: null };
}

/**
 * The environment the command runs with: the caller's, plus evidence options
 * appended to (never replacing) what it already sets. An inherited option the
 * evidence cannot coexist with is returned as the reason instead.
 */
export function evidenceEnv(runner: TestRunner, base: NodeJS.ProcessEnv, junitPath: string): { env: Record<string, string> } | { incompatible: string } {
  const env = plainEnv(base);
  if (runner === "pytest") {
    const prior = env.PYTEST_ADDOPTS ?? "";
    if (/(^|\s)--junit-?xml(=|\s|$)/.test(prior)) return { incompatible: "PYTEST_ADDOPTS already names a JUnit report (--junitxml)" };
    if (/(^|\s)-p\s*no:junitxml(\s|$)/.test(prior)) return { incompatible: "PYTEST_ADDOPTS turns the JUnit report off (-p no:junitxml)" };
    env.PYTEST_ADDOPTS = `${prior === "" ? "" : `${prior} `}--junitxml='${junitPath.replace(/'/g, `'"'"'`)}'`;
  }
  if (runner === "go") {
    const prior = env.GOFLAGS ?? "";
    if (/(^|\s)-json(=|\s|$)/.test(prior)) return { incompatible: "GOFLAGS asks for JSON output (-json)" };
    env.GOFLAGS = `${prior === "" ? "" : `${prior} `}-v`;
  }
  return { env };
}

/** The caller's environment with CI, NO_COLOR and FORCE_COLOR set, as every run gets it. */
function plainEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

/** The caller's environment without the variables the owner's adapter drops whole. */
function withoutDropped(base: NodeJS.ProcessEnv, adapter: AdapterDecision | undefined): NodeJS.ProcessEnv {
  if (adapter === undefined) return base;
  const env = { ...base };
  for (const name of adapter.drop) delete env[name];
  return env;
}

/** The one inherited variable each runner's evidence option lives in. */
const EVIDENCE_VARIABLE: Partial<Record<TestRunner, VerificationDroppable>> = { pytest: "PYTEST_ADDOPTS", go: "GOFLAGS" };

function tailLines(tail: string): string[] {
  const lines = tail.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-TAIL_LINES).map((l) => `  | ${l}`);
}

function countsText(e: Evidence): string {
  return "executed" in e && e.executed !== undefined ? `; ${e.executed} run, ${e.failed ?? 0} failed` : "";
}

/** The digest-equal second hold: the result, the completion, the record and the stages in one transaction. */
/** What a verified run records, and its first line given the stages it turned on. */
interface Verified {
  readonly counts?: { readonly executed: number; readonly failed: number };
  readonly tail: string;
  readonly line: (on: string) => string;
}

async function commit(root: string, ref: string, first: Checked, env: Readonly<Record<string, string>>, verified: Verified, options: SetupVerifyOptions): Promise<SetupVerifyResult> {
  let result: SetupVerifyResult | null = null;
  await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
    let now: Checked;
    try {
      now = await check(root, state, ref, env);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      result = stale(first.ticket, err.lines.join(" "));
      return;
    }
    if (now.ticket.id !== first.ticket.id) {
      result = stale(first.ticket, `${ref} is now ticket ${now.ticket.id}, not ${first.ticket.id}, the ticket the run was for`);
      return;
    }
    if (now.digest !== first.digest) {
      result = stale(first.ticket, "the ticket, its prerequisites, the record, the stages or the ownership changed during the run");
      return;
    }
    const at = new Date().toISOString();
    const spec = now.meta.verification.spec;
    const setup = { ...(now.ticket as Ticket & { setup: Record<string, unknown> }).setup };
    setup.verification = { ...now.meta.verification, result: { status: "verified", ...(verified.counts ? { counts: verified.counts } : {}), tailDigest: tailDigest(verified.tail), at } };
    const next = { ...now.ticket, status: "complete", completedDate: localDateOf(new Date()), setup } as Ticket;
    const decision = authoriseStatusChange(now.ticket, next, now.guard, { claimFreeReopen: false }, label(now.ticket));
    if (!decision.ok) {
      result = stale(first.ticket, decision.reason);
      return;
    }
    const completion = await prepareCompletionWrite(state, decision.ticket, root, { verificationAuthority: VERIFICATION_RESULT_AUTHORITY });
    if (completion.kind === "checkpoint-blocked") {
      result = stale(first.ticket, describeCheckpointBlock(label(now.ticket), completion.checkpoints));
      return;
    }

    const config = state.config as Config & { recipeOverrides?: Record<string, unknown> & { stages?: StagesConfig } };
    const established = establishStage(recordActivation(now.record), config.recipeOverrides?.stages ?? {}, spec.component, spec.stage);
    const record = withStageStatus(now.record, spec.component, spec.stage, "verified");
    const nextConfig = { ...config, recipeOverrides: { ...(config.recipeOverrides ?? {}), stages: established.stages }, setupVerification: record } as Config;
    const ops = [completion.op, await prepareConfigWrite(nextConfig, root)];
    await runTransactionUnlocked(root, ops.map((o) => ({ op: "write" as const, ...o })));
    invalidateResolutionWriteContext(root);
    const on = SERVES[spec.stage].filter((s) => (established.stages[s] as { enabled?: unknown } | undefined)?.enabled === true);
    result = { exitCode: 0, lines: [verified.line(on.length > 0 ? on.join(", ") : "none")] };
  });
  return result!;
}

/** The record with one component's stage moved to `status`; every other stage and component as it was. */
function withStageStatus(record: SetupVerificationRecord, component: string, stage: EstablishableStage, status: "verified" | "left-off", extra: Partial<RecordComponent> = {}): SetupVerificationRecord {
  return {
    ...record,
    components: record.components.map((c) => {
      if (c.id !== component) return c;
      const moved = stage === "test" ? { test: { ...c.test!, status } } : stage === "build" ? { build: { ...c.build!, status } } : { verify: { ...c.verify!, status } };
      return { ...c, ...moved, ...extra };
    }),
  };
}

function stale(ticket: Ticket, why: string): SetupVerifyResult {
  return { exitCode: 5, lines: [`Setup-verify stale: ${why}; nothing was written. Run storybloq setup-verify --ticket ${label(ticket)} again.`] };
}

export async function setupVerify(root: string, input: SetupVerifyInput, options: SetupVerifyOptions = {}): Promise<SetupVerifyResult> {
  const absRoot = resolve(root);
  const shape = inputShape(input);
  if (shape !== null) return { exitCode: 2, lines: [`Setup-verify refused: ${shape}`] };
  if (input.resolve !== undefined || input.reopen === true) {
    try {
      return await record(absRoot, input, options);
    } catch (err) {
      if (err instanceof Refusal) return { exitCode: 2, lines: err.lines };
      throw err;
    }
  }
  const junitDir = await mkdtemp(join(tmpdir(), "storybloq-verify-"));
  try {
    const junitPath = join(junitDir, "junit.xml");

    // The first hold: every check, the digest, and the environment the run gets.
    let first: Checked | null = null;
    let env: Record<string, string> | null = null;
    let digestEnv: Record<string, string> = {};
    let incompatible: string | null = null;
    try {
      await withProjectLock(absRoot, { strict: true, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
        const built = runEnvironment(parseSetupMeta("ticket", findTicket(state, input.ticket)), options.env ?? process.env, junitPath);
        env = built.env;
        digestEnv = built.digestEnv;
        incompatible = built.incompatible;
        first = await check(absRoot, state, input.ticket, digestEnv);
      });
    } catch (err) {
      if (err instanceof Refusal) return { exitCode: 2, lines: err.lines };
      throw err;
    }
    const checked = first as unknown as Checked;
    const spec = checked.meta.verification.spec;
    if (spec.stage === "build") return await runBuild(absRoot, input.ticket, checked, spec, env!, digestEnv, options);
    // identify refuses a verify stage until setup-verify runs it.
    if (spec.stage !== "test") throw new Error(`setup-verify: no run for the ${spec.stage} stage`);
    if (incompatible !== null) return unreadable(checked, spec.runner, incompatible, "");

    // Outside the lock: the command in its own process group, read as it streams.
    // The owner's adapter runs its argv with no shell; otherwise the spec's command runs through the shell.
    const adapter = checked.meta.verification.decision?.adapter;
    const scanner = new EvidenceScanner();
    const run = await runInGroup({
      command: adapter ? adapter.argv[0]! : "/bin/sh",
      args: adapter ? adapter.argv.slice(1) : ["-c", spec.command],
      cwd: checked.workdir,
      env: env!,
      timeoutMs: spec.timeoutMs,
      onData: (c) => scanner.feed(c),
    });
    const facts = scanner.end();
    if (run.cleanup === "unconfirmed") {
      return { exitCode: 5, lines: [`Setup-verify stopped: cleanup unconfirmed: ${run.cleanupDetail}; nothing was written.`] };
    }
    if (run.spawnError !== null) {
      return { exitCode: 1, lines: [`Verification failed: ${spec.component} test (${spec.runner}): the command could not start (${run.spawnError}). ${label(checked.ticket)} stays as it was.`] };
    }
    const junit = spec.runner === "pytest" ? await readFile(junitPath, "utf-8").catch(() => null) : null;
    const evidence = classifyEvidence(spec.runner, run, facts, junit, spec.timeoutMs);
    await setupVerifySeams.afterRun();

    if (evidence.kind === "failed") {
      return { exitCode: 1, lines: [`Verification failed: ${spec.component} test (${spec.runner}): ${evidence.reason}${countsText(evidence)}. ${label(checked.ticket)} stays as it was.`, ...tailLines(facts.tail)] };
    }
    if (evidence.kind === "no-tests") {
      return { exitCode: 1, lines: [`Verification found no tests: ${spec.component} test (${spec.runner}) ran 0 tests. ${label(checked.ticket)} stays as it was.`, ...tailLines(facts.tail)] };
    }
    if (evidence.kind === "unrecognized") return unreadable(checked, spec.runner, evidence.reason, facts.tail);

    const executed = evidence.executed;
    const verified: Verified = {
      counts: { executed, failed: 0 },
      tail: facts.tail,
      line: (on) => `Verified: ${spec.component} test (${spec.runner}, ${executed} test${executed === 1 ? "" : "s"}); stages on: ${on}`,
    };
    try {
      return await commit(absRoot, input.ticket, checked, digestEnv, verified, options);
    } catch (err) {
      if (err instanceof Refusal) return stale(checked.ticket, err.lines.join(" "));
      throw err;
    }
  } finally {
    await rm(junitDir, { recursive: true, force: true });
  }
}

function unreadable({ ticket, token }: Checked, runner: TestRunner, reason: string, tail: string): SetupVerifyResult {
  return {
    exitCode: 4,
    lines: [
      `Setup-verify stopped: the evidence of ${label(ticket)}'s run cannot be read; nothing was written (run ${token}).`,
      ambiguityLine({ class: "verification evidence unreadable", target: label(ticket), observed: reason, expected: `one ${runner} summary`, resolutions: ["adapter", "leave-off", "stop"] }),
      ...tailLines(tail),
    ],
  };
}

/**
 * A BUILD run (T-538 S3b): the approved command in its own process group,
 * against the spec's deadline. Verified is exit 0 within the deadline with no
 * pid left in the group when the command exited and the group confirmed gone;
 * a pid left behind is cleanup-failed even when the stop then removes it.
 * Every other outcome writes nothing and prints the run token, so the owner
 * can stop. Without process groups nothing runs: unsupported, exit 4.
 */
async function runBuild(root: string, ref: string, checked: Checked, spec: BuildSpec, env: Record<string, string>, digestEnv: Readonly<Record<string, string>>, options: SetupVerifyOptions): Promise<SetupVerifyResult> {
  const why = ownedGroupUnsupported();
  if (why !== null) return unsupported(checked, why);
  const scanner = new EvidenceScanner();
  const run = await runOwnedGroup(
    { command: "/bin/sh", args: ["-c", spec.command], cwd: checked.workdir, env, shutdownTimeoutMs: KILL_GRACE_MS, onData: (c) => scanner.feed(c) },
    async (group) => {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        group.exit.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), spec.timeoutMs); }),
      ]);
      clearTimeout(timer);
      return { timedOut, exited: group.exited(), left: group.leftAtLeaderExit() };
    },
  );
  const tail = scanner.end().tail;
  if (run.kind === "spawn-error") return buildFailed(checked, `the command could not start (${run.reason})`, "");
  if (!run.value.ok) throw run.value.error;
  const { timedOut, exited, left } = run.value.value;
  if (run.cleanup === "unconfirmed") return buildFailed(checked, `cleanup failed: ${run.cleanupDetail}`, tail);
  if (left === true) return buildFailed(checked, "cleanup failed: a process it started was still in its group when it exited", tail);
  if (timedOut || exited === null) return buildFailed(checked, `timed out after ${spec.timeoutMs} ms`, tail);
  if (exited.code !== 0) return buildFailed(checked, exited.signal !== null ? `ended by ${exited.signal}` : `exited with code ${exited.code}`, tail);
  await setupVerifySeams.afterRun();
  try {
    return await commit(root, ref, checked, digestEnv, { tail, line: (on) => `Verified: ${spec.component} build; stages on: ${on}` }, options);
  } catch (err) {
    if (err instanceof Refusal) return stale(checked.ticket, err.lines.join(" "));
    throw err;
  }
}

function buildFailed({ ticket, token, meta }: Checked, reason: string, tail: string): SetupVerifyResult {
  return { exitCode: 1, lines: [`Verification failed: ${meta.verification.spec.component} build: ${reason}. ${label(ticket)} stays as it was (run ${token}).`, ...tailLines(tail)] };
}

/** A stage this platform cannot run: nothing was spawned, and the owner may leave it off or stop. */
function unsupported({ ticket, token, meta }: Checked, why: string): SetupVerifyResult {
  const { component, stage } = meta.verification.spec;
  return {
    exitCode: 4,
    lines: [
      `Setup-verify stopped: ${component}'s ${stage} stage cannot run here; nothing was written (run ${token}).`,
      ambiguityLine({ class: "verification unsupported", target: label(ticket), observed: why, expected: `a platform that can own the ${stage} command's processes`, resolutions: ["leave-off", "stop"] }),
    ],
  };
}

/** The flags that go together, checked before the lock: null when the input is well formed. */
function inputShape(input: SetupVerifyInput): string | null {
  const resolving = input.resolve !== undefined;
  if (resolving && input.reopen === true) return "--resolve and --reopen do not go together.";
  if (resolving && !["adapter", "leave-off", "stop"].includes(input.resolve!)) return `--resolve takes adapter, leave-off or stop, not ${input.resolve}.`;
  if (resolving && (input.ownerWords === undefined || input.ownerWords.trim() === "")) return "a resolution records the owner's words: pass --owner-words.";
  if (!resolving && input.ownerWords !== undefined) return "--owner-words goes with --resolve.";
  if (!resolving && input.run !== undefined) return "--run goes with --resolve.";
  if (input.run !== undefined && !/^[0-9a-f]{16}$/.test(input.run)) return `--run takes the 16 hex a stopped run printed, not ${input.run}.`;
  if (input.resolve !== "adapter" && (input.argv !== undefined || input.drop !== undefined)) return "--argv and --drop go with --resolve adapter.";
  if (input.resolve === "adapter") {
    if (input.argv === undefined || input.argv.length === 0) return "an adapter needs a command: pass --argv with at least one word.";
    if (input.argv.some((a) => a === "")) return "an adapter's argv has an empty word.";
    const unknown = (input.drop ?? []).find((d) => !(VERIFICATION_DROPPABLE as readonly string[]).includes(d));
    if (unknown !== undefined) return `--drop names ${unknown}; an adapter drops only ${VERIFICATION_DROPPABLE.join(" or ")}.`;
  }
  return null;
}

/**
 * A resolution or a reopen: one hold, one transaction. The decision goes on
 * both the ticket (`verification.decision`) and the record's component
 * (`decision`, the same object).
 */
async function record(root: string, input: SetupVerifyInput, options: SetupVerifyOptions): Promise<SetupVerifyResult> {
  let result: SetupVerifyResult | null = null;
  await withProjectLock(root, { strict: true, deadlineMs: options.lockDeadlineMs }, async ({ state }) => {
    const found = identify(state, input.ticket);
    if (input.reopen === true) {
      result = await reopen(root, found);
      return;
    }
    result = await resolveWith(root, state, found, input, options.env ?? process.env);
  });
  return result!;
}

async function resolveWith(root: string, state: ProjectState, found: Identified, input: SetupVerifyInput, env: NodeJS.ProcessEnv): Promise<SetupVerifyResult> {
  assertOpen(found);
  const { ticket, meta, record } = found;
  if (input.run === undefined) throw refuse(`a resolution answers one stopped run: pass --run with the value in the first line of ${label(ticket)}'s stopped run.`);
  const spec = meta.verification.spec;
  workdirOf(root, spec.workdir);
  const kind = input.resolve!;
  const at = new Date().toISOString();
  let adapter: AdapterDecision | undefined;
  if (kind === "adapter") {
    if (spec.stage !== "test") throw refuse(`--resolve adapter: a ${spec.stage} stage has no evidence to adapt; its resolutions are leave-off and stop.`);
    const drop = [...new Set(input.drop ?? [])] as VerificationDroppable[];
    const own = EVIDENCE_VARIABLE[spec.runner];
    const unrelated = drop.find((d) => d !== own);
    if (unrelated !== undefined) throw refuse(`--drop names ${unrelated}, which ${spec.runner} does not read; ${own === undefined ? `a ${spec.runner} adapter drops nothing` : `a ${spec.runner} adapter drops only ${own}`}.`);
    if (drop.length > 0 && !("incompatible" in evidenceEnv(spec.runner, env, "<report>"))) {
      throw refuse(`--drop ${drop.join(" ")}: ${drop.join(" ")} does not conflict with the evidence options here, so the unreadable run did not come from it; drop nothing.`);
    }
    adapter = { argv: [...input.argv!], drop };
  }
  const decision: VerificationDecision = { kind, ...(adapter ? { adapter } : {}), ownerWords: input.ownerWords!.trim(), at };

  // The run it answers: everything that run depended on must be as it was (refusals first, as for a run, then staleness).
  const now = await check(root, state, input.ticket, runEnvironment(parseSetupMeta("ticket", ticket), env, "<report>").digestEnv);
  if (now.token !== input.run) return stale(ticket, `the ticket, its prerequisites, the record, the stages or the ownership changed since run ${input.run}`);
  const guard = now.guard;

  const setup = { ...(ticket as Ticket & { setup: Record<string, unknown> }).setup };
  const leaveOff = kind === "leave-off";
  setup.verification = { ...meta.verification, decision, ...(leaveOff ? { result: { status: "left-off", at } } : {}) };
  const nextRecord: SetupVerificationRecord = leaveOff
    ? withStageStatus(record, spec.component, spec.stage, "left-off", { decision })
    : { ...record, components: record.components.map((c) => (c.id !== spec.component ? c : { ...c, decision })) };

  let ticketOp: Awaited<ReturnType<typeof prepareTicketWrite>>;
  if (leaveOff) {
    const next = { ...ticket, status: "complete", completedDate: localDateOf(new Date()), setup } as Ticket;
    const authorised = authoriseStatusChange(ticket, next, guard, { claimFreeReopen: false }, label(ticket));
    if (!authorised.ok) throw refuse(authorised.reason);
    const completion = await prepareCompletionWrite(state, authorised.ticket, root, { verificationAuthority: VERIFICATION_RESULT_AUTHORITY });
    if (completion.kind === "checkpoint-blocked") throw refuse(describeCheckpointBlock(label(ticket), completion.checkpoints));
    ticketOp = completion.op;
  } else {
    ticketOp = await prepareTicketWrite({ ...ticket, setup } as Ticket, root, { verificationAuthority: VERIFICATION_RESULT_AUTHORITY });
  }
  // The stages are not touched: leave-off turns nothing on, and an adapter or stop changes only the decision.
  const nextConfig = { ...state.config, setupVerification: nextRecord } as Config;
  const ops = [ticketOp, await prepareConfigWrite(nextConfig, root)];
  await runTransactionUnlocked(root, ops.map((o) => ({ op: "write" as const, ...o })));
  invalidateResolutionWriteContext(root);

  if (kind === "leave-off") return { exitCode: 0, lines: [`Left off: ${spec.component} ${spec.stage}; ${label(ticket)} is complete and the stages are unchanged.`] };
  if (kind === "stop") return { exitCode: 0, lines: [`Decision recorded for ${label(ticket)}: stop. Nothing else changed.`] };
  return { exitCode: 0, lines: [adapterLine(ticket, (spec as TestSpec).runner, spec.workdir, adapter!, env)] };
}

/** What the next run will do: the argv, and exactly what each dropped variable held and what replaces it. */
function adapterLine(ticket: Ticket, runner: TestRunner, workdir: string, adapter: AdapterDecision, env: NodeJS.ProcessEnv): string {
  const replaced = evidenceEnv(runner, withoutDropped(env, adapter), "<report>");
  const drops = adapter.drop.map((name) => {
    const held = env[name];
    const now = "env" in replaced ? replaced.env[name] : undefined;
    return `${name} (${held === undefined ? "not set" : JSON.stringify(held)}) is dropped and replaced by ${now === undefined ? "nothing" : `${name}=${now}`}`;
  });
  return `Decision recorded for ${label(ticket)}: adapter. The next storybloq setup-verify --ticket ${label(ticket)} runs ${JSON.stringify(adapter.argv)} in ${workdir} with no shell${drops.length > 0 ? `; ${drops.join("; ")}` : ""}.`;
}

/**
 * The recovery for a ticket a writer outside the guard closed without a
 * result. With claim material on the ticket, ownership is checked against it
 * as it stands; claim-free, the reopen is this command's only for a
 * canonical establishment ticket that is complete with no result and whose
 * component is still pending (v3 note 2).
 */
async function reopen(root: string, found: Identified): Promise<SetupVerifyResult> {
  const { ticket, meta, component } = found;
  const spec = meta.verification.spec;
  if (meta.verification.result) throw refuse(`${label(ticket)} is already ${meta.verification.result.status === "verified" ? "verified" : "left off"}.`);
  const status = stageOf(component, spec.stage)!.status;
  if (status !== "pending") throw refuse(`${spec.component}'s ${spec.stage} stage is ${status === "verified" ? "already verified" : status === "left-off" ? "already left off" : status}, not pending.`);
  if (ticket.status !== "complete") throw refuse(`${label(ticket)} is ${ticket.status}, not complete; there is nothing to reopen.`);

  const guard = await ownership(root);
  const setup = { ...(ticket as Ticket & { setup: Record<string, unknown> }).setup };
  setup.verification = { ...meta.verification, reopened: [...(meta.verification.reopened ?? []), { at: new Date().toISOString() }] };
  const next = { ...ticket, status: "open", completedDate: null, setup } as Ticket;
  const authorised = authoriseStatusChange(ticket, next, guard, { claimFreeReopen: true }, label(ticket));
  if (!authorised.ok) throw refuse(authorised.reason);
  const op = await prepareTicketWrite(authorised.ticket, root, { verificationAuthority: VERIFICATION_RESULT_AUTHORITY });
  await runTransactionUnlocked(root, [{ op: "write" as const, ...op }]);
  invalidateResolutionWriteContext(root);
  return { exitCode: 0, lines: [`Reopened: ${label(ticket)} is open; run storybloq setup-verify --ticket ${label(ticket)}.`] };
}
