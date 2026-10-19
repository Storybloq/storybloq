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
import { parseSetupMeta, VERIFICATION_DROPPABLE, type AdapterDecision, type SetupItemMeta, type TestSpec, type VerificationDecision, type VerificationDroppable } from "./setup-meta.js";
import { VERIFICATION_RESULT_AUTHORITY } from "./setup-verification-guard.js";
import { readRecord, recordActivation, type RecordComponent, type SetupVerificationRecord } from "./setup-verification-record.js";
import { establishStage, SERVES, type StagesConfig } from "./verification-activation.js";
import { allKeyed, ambiguityLine } from "./setup-apply.js";
import { runInGroup } from "./process-group.js";
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

type Meta = SetupItemMeta & { readonly verification: NonNullable<SetupItemMeta["verification"]> & { readonly spec: TestSpec }; readonly establishes: NonNullable<SetupItemMeta["establishes"]> };

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

function servedStages(config: Config): Record<string, unknown> {
  const stages = (config as Config & { recipeOverrides?: { stages?: Record<string, unknown> } }).recipeOverrides?.stages ?? {};
  return Object.fromEntries(SERVES.test.map((s) => [s, stages[s] ?? null]));
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
  if (parsed.meta.verification.spec.stage !== "test") {
    throw refuse(`${label(ticket)} establishes the ${parsed.meta.verification.spec.stage} stage; this CLI runs setup-verify only for a test stage.`);
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
  if (!component || component.test === null) throw refuse(`the setup verification record has no test stage for component ${spec.component}.`);
  const mismatch = ([
    ["component", meta.establishes.component, spec.component],
    ["workdir", component.workdir, spec.workdir],
    ["command", component.test.command, spec.command],
    ["runner", component.test.runner, spec.runner],
    ["wrapper", component.test.wrapper, spec.wrapper],
  ] as const).find(([, a, b]) => a !== b);
  if (mismatch) throw refuse(`${label(ticket)}'s verification spec and the setup verification record disagree on the ${mismatch[0]} of ${spec.component} (${String(mismatch[2])} against ${String(mismatch[1])}).`);
  return { ticket, meta, record, component };
}

/** A component already verified or left off is terminal, whichever ticket asks; so is a ticket that is complete. */
function assertOpen({ ticket, meta, component }: Identified): void {
  const status = component.test!.status;
  if (status === "verified" || status === "left-off") {
    throw refuse(`${meta.verification.spec.component}'s test stage is already ${status === "verified" ? "verified" : "left off"}.`);
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

  const digest = createHash("sha256").update(JSON.stringify({
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
    stages: servedStages(state.config),
    decision: meta.verification.decision ?? null,
    guard,
    env,
  })).digest("hex");
  return { ticket, meta, record, component, guard, workdir, digest };
}

/**
 * The environment the command runs with: the caller's, plus evidence options
 * appended to (never replacing) what it already sets. An inherited option the
 * evidence cannot coexist with is returned as the reason instead.
 */
export function evidenceEnv(runner: TestRunner, base: NodeJS.ProcessEnv, junitPath: string): { env: Record<string, string> } | { incompatible: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
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
async function commit(root: string, ref: string, first: Checked, env: Readonly<Record<string, string>>, evidence: Extract<Evidence, { kind: "verified" }>, tail: string, options: SetupVerifyOptions): Promise<SetupVerifyResult> {
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
    setup.verification = { ...now.meta.verification, result: { status: "verified", counts: { executed: evidence.executed, failed: 0 }, tailDigest: tailDigest(tail), at } };
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
    const established = establishStage(recordActivation(now.record), config.recipeOverrides?.stages ?? {}, spec.component, "test");
    const record: SetupVerificationRecord = {
      ...now.record,
      components: now.record.components.map((c) => (c.id === spec.component ? { ...c, test: { ...c.test!, status: "verified" as const } } : c)),
    };
    const nextConfig = { ...config, recipeOverrides: { ...(config.recipeOverrides ?? {}), stages: established.stages }, setupVerification: record } as Config;
    const ops = [completion.op, await prepareConfigWrite(nextConfig, root)];
    await runTransactionUnlocked(root, ops.map((o) => ({ op: "write" as const, ...o })));
    invalidateResolutionWriteContext(root);
    const on = SERVES.test.filter((s) => (established.stages[s] as { enabled?: unknown } | undefined)?.enabled === true);
    result = { exitCode: 0, lines: [`Verified: ${spec.component} test (${spec.runner}, ${evidence.executed} test${evidence.executed === 1 ? "" : "s"}); stages on: ${on.length > 0 ? on.join(", ") : "none"}`] };
  });
  return result!;
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
        const pre = findTicket(state, input.ticket);
        const meta = parseSetupMeta("ticket", pre);
        const preSpec = meta.kind === "item" ? meta.meta.verification?.spec : undefined;
        const runner = preSpec?.stage === "test" ? preSpec.runner : undefined;
        const adapter = meta.kind === "item" ? meta.meta.verification?.decision?.adapter : undefined;
        const built = runner === undefined ? { env: {} } : evidenceEnv(runner, withoutDropped(options.env ?? process.env, adapter), junitPath);
        if ("incompatible" in built) incompatible = built.incompatible;
        else env = built.env;
        // The report path differs on every run, so the digest reads it as a placeholder.
        digestEnv = env === null ? {} : { ...env, ...(env.PYTEST_ADDOPTS === undefined ? {} : { PYTEST_ADDOPTS: env.PYTEST_ADDOPTS.replace(junitPath, "<report>") }) };
        first = await check(absRoot, state, input.ticket, digestEnv);
      });
    } catch (err) {
      if (err instanceof Refusal) return { exitCode: 2, lines: err.lines };
      throw err;
    }
    const checked = first as unknown as Checked;
    const spec = checked.meta.verification.spec;
    if (incompatible !== null) return unreadable(checked.ticket, spec.runner, incompatible, "");

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
    if (evidence.kind === "unrecognized") return unreadable(checked.ticket, spec.runner, evidence.reason, facts.tail);

    try {
      return await commit(absRoot, input.ticket, checked, digestEnv, evidence, facts.tail, options);
    } catch (err) {
      if (err instanceof Refusal) return stale(checked.ticket, err.lines.join(" "));
      throw err;
    }
  } finally {
    await rm(junitDir, { recursive: true, force: true });
  }
}

function unreadable(ticket: Ticket, runner: TestRunner, reason: string, tail: string): SetupVerifyResult {
  return {
    exitCode: 4,
    lines: [
      `Setup-verify stopped: the evidence of ${label(ticket)}'s run cannot be read; nothing was written.`,
      ambiguityLine({ class: "verification evidence unreadable", target: label(ticket), observed: reason, expected: `one ${runner} summary`, resolutions: ["adapter", "leave-off", "stop"] }),
      ...tailLines(tail),
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
    result = input.reopen === true
      ? await reopen(root, found)
      : await resolveWith(root, state, found, input, options.env ?? process.env);
  });
  return result!;
}

async function resolveWith(root: string, state: ProjectState, found: Identified, input: SetupVerifyInput, env: NodeJS.ProcessEnv): Promise<SetupVerifyResult> {
  assertOpen(found);
  const { ticket, meta, record } = found;
  const spec = meta.verification.spec;
  workdirOf(root, spec.workdir);
  const kind = input.resolve!;
  const at = new Date().toISOString();
  let adapter: AdapterDecision | undefined;
  if (kind === "adapter") {
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

  const guard = await ownership(root);
  assertMayComplete(ticket, guard);

  const setup = { ...(ticket as Ticket & { setup: Record<string, unknown> }).setup };
  const leaveOff = kind === "leave-off";
  setup.verification = { ...meta.verification, decision, ...(leaveOff ? { result: { status: "left-off", at } } : {}) };
  const nextRecord: SetupVerificationRecord = {
    ...record,
    components: record.components.map((c) => (c.id !== spec.component ? c : {
      ...c,
      ...(leaveOff ? { test: { ...c.test!, status: "left-off" as const } } : {}),
      decision,
    })),
  };

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

  if (kind === "leave-off") return { exitCode: 0, lines: [`Left off: ${spec.component} test; ${label(ticket)} is complete and the stages are unchanged.`] };
  if (kind === "stop") return { exitCode: 0, lines: [`Decision recorded for ${label(ticket)}: stop. Nothing else changed.`] };
  return { exitCode: 0, lines: [adapterLine(ticket, spec.runner, spec.workdir, adapter!, env)] };
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
  const status = component.test!.status;
  if (status !== "pending") throw refuse(`${spec.component}'s test stage is ${status === "verified" ? "already verified" : status === "left-off" ? "already left off" : status}, not pending.`);
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
