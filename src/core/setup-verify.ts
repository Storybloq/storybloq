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
 * Exit codes: 0 verified; 1 failed or no tests; 2 refused; 4 evidence
 * unreadable; 5 stale, or the process group's cleanup unconfirmed.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  invalidateResolutionWriteContext,
  prepareConfigWrite,
  runTransactionUnlocked,
  withProjectLock,
} from "./project-loader.js";
import { localDateOf } from "./local-date.js";
import { displayIdOf } from "./resolver.js";
import { checkpointState, hasOwnerCheckpoint } from "./owner-checkpoint.js";
import { describeCheckpointBlock, prepareCompletionWrite } from "./checkpoint-evidence.js";
import { authoriseStatusChange, collectCompletionOwnership, CompletionOwnershipUnavailable } from "./status-authority.js";
import type { CompletionGuardOptions } from "./claims.js";
import { parseSetupMeta, type SetupItemMeta } from "./setup-meta.js";
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

export interface SetupVerifyInput {
  readonly ticket: string;
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

/** Everything the first hold established, and the digest the second hold must reproduce. */
interface Checked {
  readonly ticket: Ticket;
  readonly meta: Meta;
  readonly record: SetupVerificationRecord;
  readonly component: RecordComponent;
  readonly guard: CompletionGuardOptions;
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

/** The workdir as an absolute path inside the project, or a refusal. */
export function workdirOf(root: string, workdir: string): string {
  const abs = resolve(root, workdir);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw refuse(`the workdir ${workdir} is outside the project.`);
  return abs;
}

/**
 * Every check a run needs, under the lock. A refusal throws; otherwise the
 * digest covers what the run and its result depend on: the spec, the ticket's
 * status and claims, the closure's ids, statuses, edges and checkpoint
 * states, the record, the two served stages, the decision, the ownership
 * evidence and the environment the command runs with.
 */
async function check(root: string, state: ProjectState, ref: string, env: Readonly<Record<string, string>>): Promise<Checked> {
  const ticket = findTicket(state, ref);
  const parsed = parseSetupMeta("ticket", ticket);
  if (parsed.kind === "invalid") throw refuse(`${label(ticket)}'s setup field does not read: ${parsed.reason}.`);
  if (parsed.kind !== "item" || parsed.meta.establishes === undefined || parsed.meta.verification === undefined) {
    throw refuse(`${label(ticket)} is not an establishment ticket; setup-verify runs only on a ticket a setup created to establish a test stage.`);
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
  if (component.test.status === "verified" || component.test.status === "left-off") {
    throw refuse(`${spec.component}'s test stage is already ${component.test.status === "verified" ? "verified" : "left off"}.`);
  }

  if (ticket.status === "complete") {
    throw refuse(meta.verification.result
      ? `${label(ticket)} is already ${meta.verification.result.status === "verified" ? "verified" : "left off"}.`
      : `${label(ticket)} is complete without a verification result; reopen it with storybloq setup-verify --ticket ${label(ticket)} --reopen.`);
  }
  workdirOf(root, spec.workdir);
  const prerequisites = closure(state, ticket);

  let guard: CompletionGuardOptions;
  try {
    guard = await collectCompletionOwnership(root);
  } catch (err) {
    if (!(err instanceof CompletionOwnershipUnavailable)) throw err;
    throw refuse(`ownership cannot be verified: ${err.unreadable ? err.message : `the session store (.story/sessions) could not be read (${err.message}).`}`);
  }
  const decision = authoriseStatusChange(ticket, { ...ticket, status: "complete" } as Ticket, guard, { claimFreeReopen: false }, label(ticket));
  if (!decision.ok) throw refuse(decision.reason);

  const digest = createHash("sha256").update(JSON.stringify({
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
  return { ticket, meta, record, component, guard, digest };
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
        const runner = meta.kind === "item" ? meta.meta.verification?.spec.runner : undefined;
        const built = runner === undefined ? { env: {} } : evidenceEnv(runner, options.env ?? process.env, junitPath);
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
    const scanner = new EvidenceScanner();
    const run = await runInGroup({
      command: "/bin/sh",
      args: ["-c", spec.command],
      cwd: workdirOf(absRoot, spec.workdir),
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
