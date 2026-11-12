/**
 * T-536: runs one onboarding evaluation -- one client, one fixture, one
 * variant -- as scripted owner turns against a headless client, and records
 * what each turn did and what the approved setup left on disk.
 *
 *   npx tsx scripts/onboarding-eval-run.ts --client claude|codex --fixture <name>
 *     [--variant none|reviewer-unavailable|degraded|approval-boundary] [--model <m>] --out <dir> --raw-out <dir>
 *     [--variant interrupted|interrupted-edited --fault <point[#n]> | --fault-schedule <session>=<id>:<selector>[,...]]
 *     [--variant milestone-demo|empty-idea-verify|restart]
 *
 * The session variants (T-538 S5a, onboarding-eval-sessions.ts) run the setup
 * as the `none` variant, then each later session as a fresh client. `--fault`
 * sets STORYBLOQ_EVAL_FAULT for the first session only. T-538 6.1:
 * `--fault-schedule` arms one entry per session, sessions 1 to k, each with its
 * own STORYBLOQ_EVAL_FAULT_ID; `--fault <sel>` is `1=f1:<sel>`. The attempt then
 * has k + 1 sessions, the last unarmed.
 *
 * Run it only inside a box lease. The client works on a standalone copy of the
 * fixture in a scratch directory, with a fresh config that carries THIS
 * checkout's skill and MCP server (dist/ must be built), never the installed
 * ones. Claude Code needs CLAUDE_CODE_OAUTH_TOKEN; Codex uses the existing
 * CODEX_HOME auth by symlink. No API keys: subscription auth only. Inherited
 * client variables (CODEX_*, STORYBLOQ_*, XDG_*, Claude's config and session
 * ids) are dropped; both clients, and a Codex reviewer Claude launches from its
 * shell, resolve only scratch homes, verified before the first turn.
 *
 * Turn script: discovery answers while the client asks (the three-round
 * bound is this harness's budget, not a product rule), then "Inspect details",
 * the fixture's adjustment, and approval. The reviewer-unavailable variant
 * answers the retry-or-continue stop with "Continue without independent
 * review". The approval-boundary variant replaces inspect and adjust with the
 * fixture's approval probe (a reply that is not approval), which must be answered
 * by the clean package question again with nothing written, then approves with
 * the fixture's affirmative reply. Every pre-approval stop must end at the expected question with no
 * write and no execution (nested agents included), and the project tree must
 * be unchanged until approval. An infrastructure failure (spawn error,
 * timeout, signal, nonzero exit, no terminal event) fails the run and stops it.
 *
 * Verdicts: FAIL (exit 1) on any mechanical failure; PENDING_SEMANTIC (exit 3)
 * when the mechanical checks pass; PASS (exit 0) only after
 *   npx tsx scripts/onboarding-eval-run.ts --finalize <recordDir> --judge <judge.json>
 * binds a judge result (Codex through the bridge at tier max, observed model
 * named) to this run's grading packet and every semantic line passes. The
 * review line passes only when the judge cites a review candidate the packet
 * offered. Finalize refuses, writing nothing, a packet whose hash or run id
 * does not match the record.
 *
 * A finished run is regraded, without running it again, by
 *   npx tsx scripts/onboarding-eval-run.ts --regrade <recordDir> --raw <rawDir> [--judge <judge.json>]
 * which replays the stored raw turns through the same flow and writes
 * regrade/NNN/ beside the record (onboarding-eval-regrade.ts).
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { byteBudget, copyBounded, walkNoFollow, type WalkHook } from "./onboarding-eval-walk.js";
import { newProgress, resultPathOf, withRunnerResult } from "./onboarding-eval-runner-result.js";
import { admissionRefusal, isolationFlag, probeTurnArgs, runProbeTurn, type StandInAdmission } from "./onboarding-eval-probe.js";
import { type GroupControl } from "../src/core/process-group.js";
import { runInGroup } from "./onboarding-eval-groups.js";
import {
  codexApprovalProblems, codexApprovalTables, envFor, envKeyProblems, HOST_CHECKS_RAW, hostChecksText, launchHeld, leftoverCheck, processOutcome, serverLaunchFailure, serverLaunchLines,
  sandboxedRun, serverLaunch, TURN_LIMITS, writeServerLauncher, type SandboxedRun, TurnCapture, type AttemptCapture, type EnvInputs, type LeftoverCheck, type ProcessOutcome, type TurnHostChecks,
} from "./onboarding-eval-host.js";
import {
  claudeArgvProblems, claudePolicyObject, claudePolicySettings, claudeReadback, claudeTurnArgs, initEventConsulted, initEventProblems, policyFileProblems, READBACK_TIMEOUT_MS, readbackExpected, userMessage,
  type ClaudeExpected, type ReadbackIo, type ReadbackStep,
} from "./headless-policy.js";

import { ALTERNATE_AUTH_ENV_VARS, assertSubscriptionAuthOnly, writeAtomic } from "./headless-common.js";
import { parseStream, sha256 } from "./continuity-lib.js";
import {
  driveFlow, finishDrive, inspectAfter, inventoryFor, newDriveState, packetText as buildPacketText, setupRecordFrom, writesAfterApprovalOf,
  type PackageTurn, type StoryReader, type TurnResponse, type Variant,
} from "./onboarding-eval-drive.js";
import {
  CHECK_SET_VERSION, claudeTurn, codexSandboxProblems, codexRolloutModels, rolloutInstructions, codexTurn, digestChanges, recipeContract, rubricFor, runtimeExclusion, runVerdict, semanticStopLine, TREE_EXCLUSION_LINE, shellQuote, turnArgs,
  type EvalTurn, type ExpectedRecipe, type JudgeResult, type RunVerdict, type RuntimeExclusion, type StopCheck,
} from "./onboarding-eval-lib.js";
import { applySetupReviewChecks, STORE_COPY } from "./onboarding-eval-checkset6.js";
import { ancestorProblems, canaryProblems, makeCanary, attemptBase, CLAUDE_STATE_DIRS, CODEX_STATE_DIRS, configProblems, credentialLinkEntry, fileEntry, treeEntries, type Manifest, type ManifestEntry as ConfigEntry } from "./onboarding-eval-config.js";
import { hitText, type Collected, type Purpose, type ScanResult } from "./onboarding-eval-collect.js";
import { ReviewBudget, ReviewServer, ReviewTurn, SERVED_DEADLINE_MS, SERVED_RAW, servedLinesText, STREAM_CAP_BYTES, type ServeCommand, type ServedLine } from "./onboarding-eval-review.js";
import { applySetupRunChecks, cs7FinalLedger, type Cs7FinalLedger, type FollowUp } from "./onboarding-eval-checkset7.js";
import type { InvocationMapping } from "./onboarding-eval-checkset7-events.js";
import { buildEval, EVAL_DIST } from "./build-eval.mjs";
import {
  applySessionChecks, type FaultSnapshots, attemptBypassAsync, baseVariant, gatedTicket, isDemoVariant, isFaultVariant, isSessionVariant, laterSessions, NO_FACTS, observationsText, OBSERVATIONS_RAW, ownerEdits, sessionScript,
  sessionSpans, SESSIONS_RAW, sessionsText, setupIdOf, storeRevisionCount, SESSION_VARIANTS, variantFixture, type HarnessFacts, type SessionVariant,
  demoFacts,
} from "./onboarding-eval-sessions.js";
import { armedIn, killSnapshot, scheduleFact, scheduleFor, type ScheduleEntry } from "./onboarding-eval-schedule.js";
import { EDITED_RAW, END_RAW, killRaw, protectedPathsOf, provisionedLockfiles } from "./onboarding-eval-preserve.js";
import { pinWrites, provisionClientHome } from "./onboarding-eval-client-home.js";
import { copyStateParts, recomputeStates, stateDir, stateNames, stateRecord, STATES_RAW, statesText, parseStateRecords, type StateRecord } from "./onboarding-eval-states.js";
import { cs7SnapshotLedger, type EvidenceObservation } from "./onboarding-eval-checkset7.js";
import { readEventsLog } from "./onboarding-eval-checkset7-events.js";
import { EVENTS_RAW, INVOCATIONS_RAW, runRegrade, SNAPSHOT_RAW, type ManifestEntry, type RegradeInput, type RegradeJudge, type StoryBytes } from "./onboarding-eval-regrade.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG_ROOT, "test", "fixtures", "onboarding");
const SCAFFOLD_DIRS = ["tickets", "issues", "handovers", "notes", "lessons"] as const;

type Client = "claude" | "codex";
export type { PackageTurn, Variant } from "./onboarding-eval-drive.js";
export { approvalProbeFinding } from "./onboarding-eval-drive.js";

interface Options {
  readonly client: Client;
  readonly fixture: string;
  readonly variant: Variant | SessionVariant;
  /** The session variants' fault selector for the first session, or null. */
  readonly fault: string | null;
  /** T-538 6.1: the fault schedule, one entry per armed session (`--fault <sel>` is `1=f1:<sel>`), or null. */
  readonly schedule: readonly ScheduleEntry[] | null;
  readonly model: string;
  readonly out: string;
  readonly rawOut: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
  /** T-538 commit 1: the pinned storybloq tool inventory for a Claude run (`--tool-sets`, else TOOL_SETS_FILE); read by the runner only. */
  readonly toolSets: string | null;
  /** How long each readback control request may take (4.4: 30 s); lower only in tests. */
  readonly readbackTimeoutMs: number;
  /** 5.6: the folder each attempt tree is made in; the per-user temp folder unless a test names another. */
  readonly attemptBase: string;
  /** T-538 commit 4 (section 8 step 3): the Claude arm's probe turn, behind the owner's ack and the pinned prompt; null for a cell run. */
  readonly probeTurn: { readonly ack: string; readonly promptFile: string } | null;
}

/** Plan 5.4's pinned inventory: the degraded and full lists, and the withheld names with their reasons. */
export const TOOL_SETS_FILE = join(PKG_ROOT, "scripts", "onboarding-eval-tools.json");

/** The two storybloq tool inventories: before a project exists and after. */
export interface ClaudeToolSets { readonly degraded: readonly string[]; readonly full: readonly string[] }

/** The tool sets a Claude run uses: the given file, else the pinned one; neither refuses the run before any spawn. */
export function claudeToolSets(given: string | null, pinned = TOOL_SETS_FILE): ClaudeToolSets {
  const path = given ?? (existsSync(pinned) ? pinned : null);
  if (path === null) throw new Error("onboarding-eval: no pinned tool inventory (plan 5.4)");
  const v = JSON.parse(readFileSync(path, "utf-8")) as { degraded?: unknown; full?: unknown };
  const names = (x: unknown): string[] => {
    if (!Array.isArray(x) || x.length === 0 || x.some((n) => typeof n !== "string" || !/^storybloq_[a-z0-9_]+$/.test(n))) throw new Error(`onboarding-eval: the tool inventory ${path} is not two lists of storybloq tool names`);
    return x as string[];
  };
  return { degraded: names(v.degraded), full: names(v.full) };
}

/**
 * T-538 signed-in note section 2: the run's admission, before anything is read, spawned or written. A claude
 * run is refused whatever its isolation (omitted means fresh); codex runs fresh only.
 */
export function runAdmission(argv: readonly string[], admission?: StandInAdmission): "fresh" {
  const isolation = isolationFlag(argv);
  const c = argv.indexOf("--client");
  const refused = admissionRefusal(c >= 0 ? argv[c + 1] ?? "" : "", isolation, "onboarding-eval", admission);
  if (refused !== null) throw new Error(refused);
  return "fresh";
}

function parseArgs(argv: readonly string[], admission?: StandInAdmission): Options {
  runAdmission(argv, admission);
  const get = (k: string, d?: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const client = get("client") as Client;
  if (client !== "claude" && client !== "codex") throw new Error("--client must be claude or codex");
  const fixture = get("fixture") ?? "";
  if (!/^[a-z-]+$/.test(fixture) || !existsSync(join(FIXTURES, fixture, "rubric.json"))) throw new Error(`--fixture ${fixture} is not a fixture under ${FIXTURES}`);
  const variant = (get("variant", "none") ?? "none") as Variant | SessionVariant;
  if (!["none", "reviewer-unavailable", "degraded", "approval-boundary", ...SESSION_VARIANTS].includes(variant)) throw new Error(`--variant must be none, reviewer-unavailable, degraded, approval-boundary or ${SESSION_VARIANTS.join(", ")}`);
  const schedule = faultScheduleFor(variant, get("fault") ?? null, get("fault-schedule") ?? null);
  const fault = schedule === null ? null : schedule[0]!.selector;
  const fixed = isSessionVariant(variant) ? variantFixture(variant) : null;
  if (fixed !== null && fixture !== fixed) throw new Error(`--variant ${variant} runs on fixture ${fixed}`);
  // Codex has no way to start a session with the MCP tools deferred, so the degraded condition cannot be produced there.
  if (variant === "degraded" && client !== "claude") throw new Error("--variant degraded is supported for --client claude only");
  const out = get("out"); const rawOut = get("raw-out");
  if (!out || !rawOut) throw new Error("--out and --raw-out are required");
  return {
    client, fixture, variant, fault, schedule,
    model: get("model", client === "claude" ? "claude-opus-5-5" : "gpt-6-astra")!,
    out: resolve(out), rawOut: resolve(rawOut),
    timeoutMs: Number(get("timeout-ms", String(40 * 60_000))),
    maxBudgetUsd: Number(get("max-budget-usd", "15")),
    toolSets: get("tool-sets") === undefined ? null : resolve(get("tool-sets")!),
    readbackTimeoutMs: Number(get("readback-timeout-ms", String(READBACK_TIMEOUT_MS))),
    attemptBase: resolve(get("attempt-base") ?? attemptBase()),
    probeTurn: argv.includes("--probe-turn") ? probeTurnArgs(argv, client, variant, admission) : null,
  };
}

/** A finished process as the bypass record reads it: with no exit status, how it ended is the whole story. */
export function spawnedResult(r: { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout: string | null; stderr: string | null }): { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout: string; stderr: string } {
  return { status: r.status, signal: r.signal, ...(r.error ? { error: r.error } : {}), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The fault selector a variant takes: `--fault` is refused for any variant but interrupted*, and those require one. */
export function faultFor(variant: string, fault: string | null): string | null {
  if (fault !== null && !isFaultVariant(variant)) throw new Error(`--fault is refused for --variant ${variant}: only interrupted and interrupted-edited take one`);
  if (fault === null && isFaultVariant(variant)) throw new Error(`--variant ${variant} needs --fault <point[#n]>`);
  if (fault !== null && !/^[a-z][a-z0-9:_.\/-]*(#[1-9][0-9]*)?$/i.test(fault)) throw new Error(`--fault ${fault} is not a point or point#n`);
  return fault;
}

/**
 * T-538 6.1: the schedule a run takes. `--fault-schedule <session>=<id>:<selector>[,...]` and `--fault` are
 * exclusive; both are refused for a variant that is not interrupted*, and those need one of them.
 */
export function faultScheduleFor(variant: string, fault: string | null, schedule: string | null): readonly ScheduleEntry[] | null {
  if (schedule === null) return scheduleFor(faultFor(variant, fault), null);
  if (!isFaultVariant(variant)) throw new Error(`--fault-schedule is refused for --variant ${variant}: only interrupted and interrupted-edited take one`);
  return scheduleFor(fault, schedule);
}

/** Scripted owner turns, read from the fixture's owner-answers.md sections. */
export interface OwnerScript {
  readonly discovery: string;
  readonly adjustment: string;
  readonly approval: string;
  /** The approval-boundary variant's first reply to the package: not approval. Empty when the fixture has none. */
  readonly probe: string;
  /** The approval-boundary variant's approval: an affirmative reply in the owner's own words. Empty when the fixture has none. */
  readonly affirmative: string;
}

export function ownerScript(text: string): OwnerScript {
  const section = (title: RegExp): string => {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^## /.test(l) && title.test(l));
    if (start < 0) return "";
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  };
  return {
    discovery: section(/Discovery answers|Rulings/i),
    adjustment: section(/Adjustment turn/i),
    approval: section(/^## Approval turn/i) || "Approve setup.",
    probe: section(/Approval probe turn/i),
    affirmative: section(/Affirmative approval turn/i),
  };
}


/** The owner turns after the first package, by variant. */
export function packageTurns(variant: Variant, script: OwnerScript): PackageTurn[] {
  if (variant === "approval-boundary") {
    if (script.probe === "" || script.affirmative === "") throw new Error("--variant approval-boundary needs the fixture's \"Approval probe turn\" and \"Affirmative approval turn\" sections");
    return [
      { label: "approval-probe", prompt: script.probe, expected: ["package"], requireClean: true },
      { label: "approve", prompt: script.affirmative, expected: null, requireClean: false },
    ];
  }
  return [
    { label: "inspect", prompt: "Inspect details: show me the coverage map.", expected: ["package"], requireClean: false },
    { label: "adjust", prompt: script.adjustment, expected: ["package"], requireClean: false },
    { label: "approve", prompt: script.approval, expected: null, requireClean: false },
  ];
}


/** A standalone copy of the fixture project: placeholders dropped, git-untrackable scaffold dirs created. */
/** Dependency install folders the archive leaves out (T-538 S5b): no rule reads them, and 18 runs of them would eat the disk. */
export const ARCHIVE_OMITTED_DIRS: ReadonlySet<string> = new Set(["node_modules", "bower_components", ".pnpm-store", ".venv", "venv"]);
/** The record, inside the archive, of what it left out. */
export const ARCHIVE_OMITTED_FILE = ".eval-archive-omitted.json";

/** The most `archiveProject` copies of a turn's files, all together; past it each file is a named problem. */
export const ARCHIVE_BYTE_BUDGET = 512 << 20;

export interface OmittedDir { readonly path: string; readonly files: number; readonly bytes: number }
export interface ArchiveResult { readonly omitted: readonly OmittedDir[]; readonly problems: readonly string[] }

/**
 * Copies the final project tree to `dest`, symlinks kept verbatim, skipping every dependency install folder
 * at any depth; each skipped folder is recorded with its file count and byte size in `dest`/ARCHIVE_OMITTED_FILE.
 * Lockfiles are ordinary files and stay. The tree is the turn's, so the read is walkNoFollow's: nothing is
 * followed, a FIFO is never waited on, and every entry it could not read is a finding naming its path, kept in
 * the same record. A failure to write is the harness's own and throws.
 */
export function archiveProject(project: string, dest: string, hook?: WalkHook, budgetBytes = ARCHIVE_BYTE_BUDGET): ArchiveResult {
  const out = resolve(dest);
  const budget = byteBudget(budgetBytes);
  const omitted: OmittedDir[] = [];
  const problems: string[] = [];
  const measure = (rel: string): void => {
    let files = 0;
    let bytes = 0;
    const counted = walkNoFollow(basename(rel), `project/${rel}`, {
      link: (_r) => { files += 1; },
      file: (_r, _fd, st) => { files += 1; bytes += st.size; return null; },
    });
    problems.push(...counted.problems);
    omitted.push({ path: rel, files, bytes });
  };
  mkdirSync(out, { recursive: true });
  const walked = walkNoFollow(resolve(project), "project", {
    include: (rel, st) => {
      // The record's name at the top belongs to the harness; a project's file or link there is never carried over.
      if (rel === ARCHIVE_OMITTED_FILE) return false;
      if (!st.isDirectory() || !ARCHIVE_OMITTED_DIRS.has(basename(rel))) return true;
      measure(rel);
      return false;
    },
    folder: (rel) => { if (rel !== ".") mkdirSync(join(out, rel)); },
    link: (rel, target) => { symlinkSync(target, join(out, rel)); },
    file: (rel, fd, st) => {
      // Descriptor to descriptor under one budget for the whole tree: a model-sized file never sits in memory.
      const to = openSync(join(out, rel), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, st.mode & 0o777);
      let r: ReturnType<typeof copyBounded>;
      try { r = copyBounded(fd, to, budget); } finally { closeSync(to); }
      if (r === null) return null;
      rmSync(join(out, rel), { force: true });
      if ("code" in r) return r.code;
      problems.push(`project/${rel} was not copied: the archive is over its ${r.over} byte budget`);
      return null;
    },
  }, { hook });
  problems.push(...walked.problems);
  omitted.sort((a, b) => a.path.localeCompare(b.path));
  if (omitted.length > 0 || problems.length > 0) {
    writeFileSync(join(out, ARCHIVE_OMITTED_FILE), `${JSON.stringify({ omitted, ...(problems.length > 0 ? { problems } : {}) }, null, 2)}\n`, { flag: "wx" });
  }
  return { omitted, problems };
}

export function materializeFixture(fixture: string, dest: string): string {
  const project = join(dest, "project");
  cpSync(join(FIXTURES, fixture, "project"), project, { recursive: true });
  const dropKeeps = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === ".gitkeep") rmSync(p);
      else if (statSync(p).isDirectory()) dropKeeps(p);
    }
  };
  dropKeeps(project);
  if (existsSync(join(project, ".story"))) for (const d of SCAFFOLD_DIRS) mkdirSync(join(project, ".story", d), { recursive: true });
  return project;
}

/** One fixture folder's dependency install at provisioning (pen ruling R2 (a)). */
export interface DependencyInstall {
  /** The folder, project-relative (`.` for the root). */
  readonly path: string;
  /** True when the lockfile came from the fixture's `lockfiles/` folder and was copied in at provisioning. */
  readonly copied: boolean;
  readonly lockfileSha256: string;
  readonly exit: number | null;
  /** The lockfile's packages present on disk after the install (a platform's optional binaries for another platform are not). */
  readonly packages: number;
}

/** The dependency fields of a package.json that an install would fetch. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * T-538 commit 3, pen ruling R2 (a): before any turn and outside the sandbox, each `lockfiles/<folder>/package-lock.json`
 * the fixture ships beside its project is copied into that folder of the project copy (the fixture's project stays
 * byte for byte, so stored replays keep their packets), and each folder of the copy that then holds a
 * package-lock.json gets `npm ci --ignore-scripts`, so a turn can run the fixture's own test and build
 * without the network and nothing is installed during a turn. npm is the one beside the running node, with a
 * scratch HOME and cache under `scratch`, never the owner's. A package.json that declares dependencies and ships
 * no lockfile, a lockfile for a project folder that does not exist (or that already holds one), anything else under
 * `lockfiles/`, or an install that fails, stops provisioning by cause ("dependencies: ..."); it is never retried
 * inside the sandbox. `.git`, `.story` and `node_modules` are not searched.
 */
export function installFixtureDependencies(project: string, scratch: string, lockfiles: string | null, nodePath: string = process.execPath): DependencyInstall[] {
  const copied = new Set<string>();
  if (lockfiles !== null && existsSync(lockfiles)) {
    const take = (rel: string): void => {
      const abs = rel === "." ? lockfiles : join(lockfiles, rel);
      for (const name of readdirSync(abs).sort()) {
        const r = rel === "." ? name : `${rel}/${name}`;
        const st = lstatSync(join(abs, name));
        if (st.isDirectory()) { take(r); continue; }
        if (!st.isFile() || name !== "package-lock.json") throw new Error(`onboarding-eval: provisioning: dependencies: lockfiles/${r} is not a package-lock.json`);
        const folder = rel;
        const target = folder === "." ? project : join(project, folder);
        if (!(lstatSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false)) throw new Error(`onboarding-eval: provisioning: dependencies: lockfiles/${r} is for the project folder ${folder}, which does not exist`);
        // Codex round 1 P3: a lockfile's folder holds the package it locks, as a regular file, or nothing installs from it.
        if (!(lstatSync(join(target, "package.json"), { throwIfNoEntry: false })?.isFile() ?? false)) throw new Error(`onboarding-eval: provisioning: dependencies: lockfiles/${r} is for the project folder ${folder}, which holds no package.json`);
        if (existsSync(join(target, "package-lock.json"))) throw new Error(`onboarding-eval: provisioning: dependencies: lockfiles/${r} and the project's own ${folder}/package-lock.json both exist`);
        copyFileSync(join(abs, name), join(target, "package-lock.json"), fsConstants.COPYFILE_EXCL);
        copied.add(folder);
      }
    };
    take(".");
  }
  const found: string[] = [];
  const walk = (rel: string): void => {
    const dir = rel === "." ? project : join(project, rel);
    for (const name of readdirSync(dir).sort()) {
      const st = lstatSync(join(dir, name));
      if (st.isDirectory() && name !== ".git" && name !== ".story" && name !== "node_modules") walk(rel === "." ? name : `${rel}/${name}`);
      else if (st.isFile() && name === "package.json") found.push(rel);
    }
  };
  walk(".");
  const out: DependencyInstall[] = [];
  for (const rel of found) {
    const dir = rel === "." ? project : join(project, rel);
    const lockPath = join(dir, "package-lock.json");
    if (!existsSync(lockPath)) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
      const declared = DEPENDENCY_FIELDS.some((f) => pkg[f] !== null && typeof pkg[f] === "object" && Object.keys(pkg[f] as object).length > 0);
      if (declared) throw new Error(`onboarding-eval: provisioning: dependencies: ${rel}/package.json declares dependencies and the fixture ships no package-lock.json`);
      continue;
    }
    const npm = join(dirname(nodePath), "npm");
    if (!existsSync(npm)) throw new Error(`onboarding-eval: provisioning: dependencies: no npm beside ${nodePath}`);
    const npmHome = join(scratch, "npm-home");
    mkdirSync(npmHome, { recursive: true });
    const lockfileSha256 = sha256(readFileSync(lockPath));
    const r = spawnSync(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir, encoding: "utf-8", timeout: 10 * 60_000, maxBuffer: 16 << 20,
      env: { PATH: `${dirname(nodePath)}${delimiter}/usr/bin${delimiter}/bin`, HOME: npmHome, TMPDIR: npmHome, npm_config_cache: join(scratch, "npm-cache"), npm_config_update_notifier: "false" },
    });
    if (r.status !== 0) {
      const why = r.error !== undefined ? r.error.message : `exit ${r.status ?? r.signal}`;
      const first = (r.stderr ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
      throw new Error(`onboarding-eval: provisioning: dependencies: npm ci in ${rel} failed (${why})${first !== "" ? `: ${first.trim()}` : ""}`);
    }
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as { packages?: Record<string, unknown> };
    const packages = Object.keys(lock.packages ?? {}).filter((k) => k !== "" && existsSync(join(dir, k))).length;
    out.push({ path: rel, copied: copied.has(rel), lockfileSha256, exit: r.status, packages });
  }
  // P3: every copied lockfile produced a successful install; one the search never reached is a failure by cause.
  for (const folder of [...copied].sort()) {
    if (!out.some((i) => i.path === folder && i.copied && i.exit === 0)) throw new Error(`onboarding-eval: provisioning: dependencies: lockfiles/${folder === "." ? "" : `${folder}/`}package-lock.json was copied into ${folder} and nothing was installed from it`);
  }
  return out;
}

/** PATH with every `codex` executable removed: its directories are replaced by a scratch bin of links to their other executables. */
export function pathWithoutCodex(path: string, scratchBin: string): string {
  return pathWithout(path, scratchBin, ["codex"]);
}

/**
 * PATH with every directory holding one of `names` replaced by one scratch
 * directory of links to its other entries. Check set 6 (T-536) removes claude
 * too: the setup reviewer starts either, so an arm with claude left on PATH
 * would never be unavailable.
 */
export function pathWithout(path: string, scratchBin: string, names: readonly string[]): string {
  mkdirSync(scratchBin, { recursive: true });
  const out: string[] = [];
  let linked = false;
  for (const dir of path.split(delimiter).filter(Boolean)) {
    if (!names.some((n) => existsSync(join(dir, n)))) { out.push(dir); continue; }
    for (const name of readdirSync(dir)) {
      if (names.includes(name) || existsSync(join(scratchBin, name))) continue;
      try { symlinkSync(join(dir, name), join(scratchBin, name)); } catch { /* unreadable entry: skipped */ }
    }
    if (!linked) { out.push(scratchBin); linked = true; }
  }
  return out.join(delimiter);
}

/** The reviewers the reviewer-unavailable arm hides from the evaluated model's shell under a check set. */
export function hiddenReviewers(checkSet: number): string[] {
  return checkSet >= 6 ? ["codex", "claude"] : ["codex"];
}

/** The absolute path `bin` resolves to on `path`, or null. Resolved once, before any PATH filtering. */
export function resolveOnPath(bin: string, path: string): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const p = join(dir, bin);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** The launcher's text: every path and fixed argument single-quoted, so a space, `$`, backtick or quote in them stays literal. */
export function launcherScript(nodePath: string, cliPath: string, fixed: readonly string[] = []): string {
  return `#!/bin/sh\nexec ${[nodePath, cliPath, ...fixed].map(shellQuote).join(" ")} "$@"\n`;
}

/**
 * Check set 7 (T-538 S5a): every client-side storybloq process, the MCP server
 * and the CLI alike, runs the evaluation bundle, which writes the events log.
 */
export function storybloqEntry(checkSet: number, entry: "mcp" | "cli"): { readonly path: string; readonly args: readonly string[] } {
  if (checkSet < 7) return { path: join(PKG_ROOT, "dist", `${entry}.js`), args: [] };
  return { path: join(PKG_ROOT, EVAL_DIST, `eval-${entry}.js`), args: ["--entry", entry] };
}

/**
 * A scratch `storybloq` that runs THIS checkout's built CLI, placed first on
 * the eval PATH, so `config set-overrides`, the CLI fallback and any skill
 * refresh are this build and never the installed release.
 */
function installCliLauncher(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, "storybloq");
  const cli = storybloqEntry(CHECK_SET_VERSION, "cli");
  writeFileSync(launcher, launcherScript(process.execPath, cli.path, cli.args), { mode: 0o755 });
  return launcher;
}

/**
 * T-538 commit 3, pen ruling R1: the three spellings a Python rubric uses (`pytest`, `python -m pytest`, `python3
 * -m pytest`) all run the host's `python3`, so a fixture's tests resolve the same way whichever the client picks.
 * `python` and `python3` run it and `pytest` runs `python3 -m pytest` (which puts the working folder on the import
 * path, as the other spellings do). `python3` is shimmed too: a PATH whose first `python3` is another interpreter
 * (the Xcode one, without pytest) would otherwise split the spellings. The folder lies outside every root, first
 * on the client's PATH; each shim is read-only and its bytes are checked with the configuration before every
 * turn. No `python3` on the PATH: no shims, and the
 * fixture's own run names the cause.
 */
export function installPythonShims(binDir: string, path: string): string[] {
  const python3 = resolveOnPath("python3", path);
  if (python3 === null) return [];
  mkdirSync(binDir, { recursive: true });
  const shims: [string, string[]][] = [["python", []], ["python3", []], ["pytest", ["-m", "pytest"]]];
  const out: string[] = [];
  for (const [name, fixed] of shims) {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\nexec ${[python3, ...fixed].map(shellQuote).join(" ")} "$@"\n`, { mode: 0o555, flag: "wx" });
    out.push(file);
  }
  return out;
}

/**
 * Variables a parent process may carry that point a client (or a reviewer it
 * shells out to) at real homes, real config or a real task identity. None may
 * reach an eval: the runner sets the ones it needs to scratch paths itself.
 * The subscription token is the one exception, kept for Claude's auth.
 */
const INHERITED_CLIENT_ENV = /^(CODEX_|STORYBLOQ_|CLAUDESTORY_|XDG_)|^(CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_ENTRYPOINT)$/;

export function scrubClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!INHERITED_CLIENT_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * Every home a client or its reviewer can resolve lies under the scratch directory: HOME and TMPDIR always,
 * CODEX_HOME for Codex, CLAUDE_CONFIG_DIR for Claude, and no inherited client variable beyond the ones the
 * runner set. Given the client column (T-538 5.3), the key set must be exactly that column's. Returns the
 * problems; empty means isolated.
 */
export function isolationProblems(env: NodeJS.ProcessEnv, work: string, client: Client, column?: Record<string, string>): string[] {
  const problems: string[] = [];
  const under = (k: string): void => {
    const v = env[k];
    if (!v) problems.push(`${k} is not set`);
    else if (!resolve(v).startsWith(`${resolve(work)}/`)) problems.push(`${k}=${v} is outside the scratch directory`);
  };
  under("HOME");
  if (client === "codex") under("CODEX_HOME");
  else if (env.CODEX_HOME !== undefined) under("CODEX_HOME");
  under("TMPDIR");
  if (client === "claude") under("CLAUDE_CONFIG_DIR");
  // Check set 7: the evaluation entry's events log and fault selector are the runner's own.
  const allowed = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "STORYBLOQ_CLIENT", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_SETUP_REVIEW_DIR", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_EVAL_FAULT", "STORYBLOQ_EVAL_FAULT_ID", "STORYBLOQ_EVAL_REVIEW_RESPONSES"]);
  for (const k of Object.keys(env)) if (INHERITED_CLIENT_ENV.test(k) && !allowed.has(k)) problems.push(`${k} is inherited`);
  if (column !== undefined) problems.push(...envKeyProblems(env, column, "client"));
  return problems;
}

function buildIdentity(): Record<string, string> {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PKG_ROOT, encoding: "utf-8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "src", "scripts"], { cwd: PKG_ROOT, encoding: "utf-8" });
  return {
    checkoutHead: head.status === 0 ? head.stdout.trim() : "unknown",
    checkoutDirty: dirty.status === 0 ? String(dirty.stdout.trim().length > 0) : "unknown",
    cliSha256: sha256(readFileSync(join(PKG_ROOT, "dist", "cli.js"))),
    mcpSha256: sha256(readFileSync(join(PKG_ROOT, "dist", "mcp.js"))),
    skillSha256: sha256(readFileSync(join(PKG_ROOT, "src", "skill", "setup-flow.md"))),
    ...(CHECK_SET_VERSION >= 7 ? {
      evalMcpSha256: sha256(readFileSync(storybloqEntry(CHECK_SET_VERSION, "mcp").path)),
      evalCliSha256: sha256(readFileSync(storybloqEntry(CHECK_SET_VERSION, "cli").path)),
    } : {}),
  };
}

/** Claude's config folder and its manifest entries (5.6): the skill, the two files, and Claude's own state folders. */
function provisionClaude(home: string): { readonly configDir: string; readonly entries: ConfigEntry[] } {
  const configDir = join(home, "claude-config");
  mkdirSync(configDir, { recursive: true });
  cpSync(join(PKG_ROOT, "src", "skill"), join(configDir, "skills", "story"), { recursive: true });
  writeFileSync(join(configDir, "settings.json"), `${JSON.stringify({ env: {}, hooks: {} }, null, 2)}\n`);
  writeFileSync(join(configDir, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
  const entries: ConfigEntry[] = [
    ...treeEntries(join(configDir, "skills", "story")), fileEntry(join(configDir, "settings.json")), fileEntry(join(configDir, ".claude.json")),
    ...CLAUDE_STATE_DIRS.map((d): ConfigEntry => ({ kind: "runtime-dir", path: join(configDir, d) })),
  ];
  return { configDir, entries };
}

/**
 * A scratch CODEX_HOME holding only the subscription auth (by link) and a
 * config this runner wrote. As the evaluated client it also carries the tool
 * server's sandboxed launch (T-538 5.2), one approval per inventory name (5.4,
 * Addendum B) and this checkout's skill; the server's environment arrives per
 * turn (5.3), so the config names no variable. As Claude's shell-launched
 * reviewer it carries nothing else: no MCP servers, no skills, no sessions, no
 * profiles.
 */
function provisionCodexHome(home: string, realAuth: string, role: "client" | "reviewer", variant: Variant, server?: { readonly launch: { readonly command: string; readonly args: readonly string[] }; readonly tools: readonly string[]; readonly project: string }): { readonly codexHome: string; readonly entries: ConfigEntry[] } {
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const entries: ConfigEntry[] = [];
  if (existsSync(realAuth)) {
    symlinkSync(realAuth, join(codexHome, "auth.json"));
    entries.push(credentialLinkEntry(join(codexHome, "auth.json")));
  } else if (role === "client") throw new Error(`onboarding-eval: no Codex auth at ${realAuth}`);
  let text = "";
  if (role === "client") {
    if (server === undefined) throw new Error("onboarding-eval: the Codex client needs its tool server launch");
    cpSync(join(PKG_ROOT, "src", "skill"), join(home, ".agents", "skills", "story"), { recursive: true });
    const lines = [
      "[mcp_servers.storybloq]",
      `command = ${JSON.stringify(server.launch.command)}`,
      `args = [${server.launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ];
    if (variant === "reviewer-unavailable") lines.push("[features]", "multi_agent = false");
    text = `${lines.join("\n")}\n\n${codexApprovalTables(server.tools)}`;
    const weak = codexApprovalProblems(text, server.tools);
    if (weak.length > 0) throw new Error(`onboarding-eval: the Codex config's tool approvals do not hold: ${weak.join("; ")}`);
    // Addendum B rule (a), measured on codex 0.163.0: the table Codex appends on a first turn, written here last in its
    // exact form, leaves the file byte-identical over turns, so the manifest's hash stays strict.
    text = `${text.endsWith("\n") ? text : `${text}\n`}${codexTrustTable(server.project)}`;
    entries.push(...treeEntries(join(home, ".agents", "skills", "story")));
  }
  writeFileSync(join(codexHome, "config.toml"), text);
  entries.push(fileEntry(join(codexHome, "config.toml")), ...CODEX_STATE_DIRS.map((d): ConfigEntry => ({ kind: "runtime-dir", path: join(codexHome, d) })));
  return { codexHome, entries };
}

/** The project trust table exactly as codex 0.163.0 appends it to config.toml (Addendum B), a blank line first. */
export function codexTrustTable(project: string): string {
  return `\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`;
}

/**
 * 5.5: the served reviewer's own folders. `reviewer-bin` holds links to node, git and, unless the variant is
 * reviewer-unavailable, codex; never claude. `reviewer-home/.codex` holds only the link to the owner's
 * auth.json, made with symlink and checked with lstat, never opened.
 */
/** 5.8: one collector call's deadline (the attempt remainder of 7.4 comes with commit 4). */
export const COLLECT_DEADLINE_MS = 120_000;
const COLLECT_STDOUT_CAP = 256 * 1024 * 1024;

/** A purpose whose problems end the attempt as infrastructure; the others are named and scored without. */
const EVIDENCE_PURPOSES: readonly Purpose[] = ["ledger", "events", "store"];

/**
 * 5.8: the runner never reads a model-writable tree itself. Each read is one collector process, in its own
 * group under a deadline, that copies (or digests, archives, observes) and prints its result; the runner reads
 * only the printed result and the copy under `work/collected/<n>/`, outside every root.
 */
export class Collector {
  private n = 0;
  /** Problems in project files and rollouts: named in the record, the run scored without them. */
  readonly named: string[] = [];
  constructor(private readonly work: string, private readonly o: { readonly deadlineMs?: number; readonly script?: string; readonly execArgv?: readonly string[] } = {}) {}

  async call(args: readonly string[], what: string, stdin?: Buffer): Promise<unknown> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let len = 0;
    const deadlineMs = this.o.deadlineMs ?? COLLECT_DEADLINE_MS;
    const tmp = join(this.work, "collected");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const r = await runInGroup({
      command: process.execPath, args: [...(this.o.execArgv ?? process.execArgv), this.o.script ?? join(PKG_ROOT, "scripts", "onboarding-eval-collect.ts"), ...args], cwd: tmp,
      env: { PATH: "/usr/bin:/bin", HOME: tmp, TMPDIR: tmp, LANG: "C" }, timeoutMs: deadlineMs, killGraceMs: TURN_LIMITS.graceMs, stdin: stdin ?? Buffer.alloc(0),
      onStdout: (c) => { if (len < COLLECT_STDOUT_CAP) { out.push(c); len += c.length; } },
      onStderr: (c) => { if (err.length < 64) err.push(c); },
    });
    const unconfirmed = r.cleanup !== "confirmed" ? "; its stop was not confirmed, so the attempt is quarantined" : "";
    if (r.timedOut) throw new Error(`onboarding-eval: evidence: ${what}: the collector passed its ${deadlineMs} ms deadline and was stopped${unconfirmed}`);
    if (r.exitCode !== 0 || unconfirmed !== "") throw new Error(`onboarding-eval: evidence: ${what}: the collector failed (${r.spawnError ?? r.exitCode ?? r.signal})${unconfirmed}: ${Buffer.concat(err).toString("utf-8").trim()}`);
    return JSON.parse(Buffer.concat(out).toString("utf-8"));
  }

  /** A copy of `src` (a folder) for one purpose; the path returned mirrors `src` and is absent when `src` was. */
  async copy(purpose: Purpose, src: string): Promise<string> {
    const dest = join(this.work, "collected", String(++this.n), basename(src));
    const c = await this.call(["collect", purpose, src, dest], src) as Collected;
    for (const e of c.entries) {
      if (e.problem === null) continue;
      const at = e.path === "." ? src : join(src, e.path);
      if (EVIDENCE_PURPOSES.includes(purpose)) throw new Error(`onboarding-eval: evidence: ${at}: ${e.problem}`);
      this.named.push(`evidence: ${at}: ${e.problem}`);
    }
    return dest;
  }

  /**
   * Codex round 1 P4: the project as a tree snapshot in the kill snapshot's form, walked in a collector process.
   * `.git` and every `node_modules` are left out before anything is charged to the bound, links are recorded by
   * path, and every problem the walk met is in the snapshot, where it fails the preservation check.
   */
  async snapshot(root: string): Promise<string> {
    const r = await this.call(["snapshot", root], root) as { text?: unknown };
    if (typeof r.text !== "string") throw new Error(`onboarding-eval: evidence: ${root}: the collector's snapshot is not text`);
    return r.text;
  }

  async digest(root: string): Promise<Record<string, string>> {
    const d = await this.call(["digest", root], root) as { digest: Record<string, string>; problems: string[] };
    for (const p of d.problems) this.named.push(`evidence: ${p}`);
    return d.digest;
  }

  archive(project: string, dest: string): Promise<ArchiveResult> { return this.call(["archive", project, dest], project) as Promise<ArchiveResult>; }
  observe(project: string, at: EvidenceObservation["at"]): Promise<EvidenceObservation[]> { return this.call(["observe", project, JSON.stringify(at)], project) as Promise<EvidenceObservation[]>; }
  /** 5.9: the held secrets go on stdin, never on the command line. */
  scan(paths: readonly string[], secrets: readonly string[]): Promise<ScanResult> {
    return this.call(["scan", ...paths], paths.join(", "), Buffer.from(secrets.join("\n"), "utf-8")) as Promise<ScanResult>;
  }

  /** F8: the project scan (5.6) in a collector process under its deadline, never in the runner. */
  projectScan(project: string): Promise<string[]> { return this.call(["project-scan", project], project) as Promise<string[]>; }

  ledgerState(story: string): Promise<{ readonly digest: string; readonly problems: readonly string[] }> { return this.call(["ledger-state", story], story) as Promise<{ digest: string; problems: string[] }>; }
}

/** 5.9: a packet over this is refused, not partly scanned. */
export const PACKET_LIMIT_BYTES = 16 * 1024 * 1024;
/** 5.9: written beside the record when the attempt is invalid; the judge refuses a record that has one. */
export const INVALID_FILE = "invalid.json";
/** F13: stands in a published record until its 5.9 scan clears; the judge refuses a record that holds it. */
export const SCAN_PENDING_FILE = "scan-pending.json";

/** F12: a harness command whose process group was not confirmed gone stops the attempt, whatever its exit, before its result is used. */
export function stopUnconfirmed<T extends { readonly cleanup: "confirmed" | "unconfirmed"; readonly status: number | null; readonly signal: NodeJS.Signals | null }>(r: T, command: string): T {
  if (r.cleanup !== "confirmed") throw new Error(`onboarding-eval: harness stop: the sandboxed harness command ${JSON.stringify(command.slice(0, 80))} ended (${r.status ?? r.signal}) but its process group was not confirmed gone; the attempt stops`);
  return r;
}

/** F13: the 5.9 scan of a published record; the pending marker goes only when it is clean, and stays on any failure. */
export async function scanAndClear(collector: Pick<Collector, "scan">, recordDir: string, rawDir: string, packetBytes: number, secrets: readonly string[]): Promise<void> {
  const scan = await collector.scan([recordDir, rawDir], secrets);
  const invalid = invalidReasons(packetBytes, scan);
  if (invalid.length > 0) {
    writeFileSync(join(recordDir, INVALID_FILE), `${JSON.stringify({ invalid, hits: scan.hits, unreadable: scan.unreadable }, null, 2)}\n`, { flag: "wx" });
    throw new Error(`onboarding-eval: invalid: ${invalid.join("; ")}; the judge is not called and the matrix stops`);
  }
  unlinkSync(join(recordDir, SCAN_PENDING_FILE));
}

/** 5.9's verdict on what would reach the judge: the reasons the attempt is invalid, empty when the scan found none. */
export function invalidReasons(packetBytes: number, scan: ScanResult): string[] {
  const out: string[] = [];
  if (packetBytes > PACKET_LIMIT_BYTES) out.push(`the packet is ${packetBytes} bytes, over the ${PACKET_LIMIT_BYTES} byte limit, and is refused, not partly scanned`);
  for (const h of scan.hits) out.push(`a credential form in ${hitText(h)}`);
  for (const u of scan.unreadable) out.push(`not scanned: ${u}`);
  return out;
}

/** 5.7: a harness command's deadline. */
const HARNESS_DEADLINE_MS = 120_000;

/** Words for /bin/sh -c, each single-quoted. */
export function shellWords(words: readonly string[]): string {
  return words.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(" ");
}

/** How long the review worker outlives a turn's deadline and twice its grace. */
const WORKER_MARGIN_MS = 60_000;

function provisionReviewer(work: string, realAuth: string, variant: Variant, codexBin: string): { readonly bin: string; readonly home: string; readonly tmp: string } {
  const bin = join(work, "reviewer-bin");
  const home = join(work, "reviewer-home");
  const tmp = join(work, "reviewer-tmp");
  mkdirSync(bin);
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(tmp);
  const git = resolveOnPath("git", process.env.PATH ?? "");
  if (git === null) throw new Error("onboarding-eval: git is not on PATH; the served reviewer needs it");
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(realpathSync(git), join(bin, "git"));
  if (variant !== "reviewer-unavailable") symlinkSync(codexBin, join(bin, "codex"));
  const link = join(home, ".codex", "auth.json");
  symlinkSync(realAuth, link);
  if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== realAuth) throw new Error("onboarding-eval: the served reviewer's auth link does not hold");
  return { bin, home, tmp };
}

/** 5.5: `node <checkout>/dist/cli.js setup-review <argv>` in its own group, cwd the project, the decoded stdin, each stream capped. */
export function serveReviewCommand(cli: string, project: string, env: NodeJS.ProcessEnv): ServeCommand {
  return async (args, stdin, timeoutMs, setStop, watch) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    // One byte past the cap is kept so the response can say it was truncated.
    const keep = (into: Buffer[], len: number, c: Buffer): number => { const room = STREAM_CAP_BYTES + 1 - len; if (room > 0) into.push(c.subarray(0, room)); return len + Math.min(room > 0 ? room : 0, c.length); };
    const r = await runInGroup({
      command: process.execPath, args: [cli, "setup-review", ...args], cwd: project, env, timeoutMs, killGraceMs: TURN_LIMITS.graceMs,
      onStdout: (c) => { watch(c, "stdout"); outLen = keep(out, outLen, c); },
      onStderr: (c) => { watch(c, "stderr"); errLen = keep(err, errLen, c); },
      control: (c: GroupControl) => { setStop(() => c.stop()); c.write(stdin); c.endInput(); },
    });
    setStop(null);
    return { exit: r.timedOut ? null : r.exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err), cleanup: r.cleanup, timedOut: r.timedOut };
  };
}

/** Claude's MCP file: the one sandboxed launch (5.2) and the server's environment column (5.3). Written new, 0600. */
export function claudeMcpText(launch: { readonly command: string; readonly args: readonly string[] }, env: Readonly<Record<string, string>>): string {
  return JSON.stringify({ mcpServers: { storybloq: { command: launch.command, args: [...launch.args], env: { ...env } } } }, null, 2);
}

function writeClaudeMcpFile(file: string, text: string): void {
  if (existsSync(file)) unlinkSync(file);
  writeFileSync(file, text, { mode: 0o600, flag: "wx" });
}

interface TurnResult {
  readonly turn: EvalTurn;
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** Spawn failure, launch check, timeout, signal, nonzero exit or a missing/failed terminal event; null when the turn ran cleanly. */
  readonly infraFailure: string | null;
  /** A Claude turn's readback exchange (4.4), saved as turn-NN-<label>.readback.json; null for Codex. */
  readonly readback: { readonly steps: readonly ReadbackStep[]; readonly mcpTools: readonly string[]; readonly permissionDenials: unknown } | null;
  /** 5.1 and 5.2: what the host saw around the turn, a replay input once the main loop names its file. */
  readonly host: Omit<TurnHostChecks, "file">;
  /** Whether the turn's process group (and its review worker's) was confirmed gone; the probe reads nothing otherwise. */
  readonly cleanup: "confirmed" | "unconfirmed";
}

/** A Claude run's launch files and the expectations each turn is checked against. */
export interface ClaudeLaunch {
  readonly model: string;
  readonly policyFile: string;
  readonly policySha256: string;
  readonly mcpFile: string;
  readonly mcpSha256: string;
  readonly mcpLaunch: { readonly command: string; readonly args: readonly string[] };
  readonly project: string;
  readonly roots: readonly string[];
  readonly toolSets: ClaudeToolSets;
  readonly maxBudgetUsd: number;
}

/** The names the policy allows: the full inventory, then any degraded-only name. */
export const allowedToolsOf = (t: ClaudeToolSets): string[] => [...t.full, ...t.degraded.filter((n) => !t.full.includes(n))];

/** What this launch must have in force: the tool set by whether the project exists yet (5.4). */
export function launchExpected(l: ClaudeLaunch): ClaudeExpected {
  const present = existsSync(join(l.project, ".story", "config.json"));
  return {
    model: l.model, policyFile: l.policyFile, policySha256: l.policySha256, mcpFile: l.mcpFile, mcpSha256: l.mcpSha256, project: l.project, roots: l.roots,
    allowedTools: allowedToolsOf(l.toolSets), mcpTools: present ? l.toolSets.full : l.toolSets.degraded, mcpLaunch: l.mcpLaunch, maxBudgetUsd: l.maxBudgetUsd,
  };
}

/** The observed models from this thread's rollout file under the scratch CODEX_HOME. */
export function rolloutModels(codexHome: string, threadId: string): string[] {
  return codexRolloutModels(rolloutLines(join(codexHome, "sessions"), threadId));
}

/** Every parsed line of this thread's rollout files under a sessions folder (5.8: the collector's copy of the client's). */
function rolloutLines(sessionsDir: string, threadId: string): Record<string, unknown>[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && name.includes(threadId)) found.push(p);
    }
  };
  walk(sessionsDir);
  const lines: Record<string, unknown>[] = [];
  for (const f of found) {
    for (const l of readFileSync(f, "utf-8").split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* partial line */ } }
  }
  return lines;
}

interface TurnCtx {
  readonly project: string;
  /** The client column (5.3), replaced between sessions when the fault variables change. */
  env: NodeJS.ProcessEnv;
  /** The server column, delivered to Codex per turn; Claude reads it from its MCP file. */
  serverEnv: Readonly<Record<string, string>>;
  readonly clientBin: string;
  readonly writableRoots: readonly string[];
  claude: ClaudeLaunch | null;
  sessionId: string | null;
  first: boolean;
  /** 5.1 and 5.2: the attempt tree the leftover check reads, the events log the launch lines land in, the pinned inventory's sha256, and the attempt's capture so far. */
  readonly host: { readonly tree: string; readonly events: string; readonly toolsSha256: string; readonly capture: AttemptCapture };
  /** 5.5: starts the turn's review side (the collector worker and the server) for a turn with this deadline; the stop ends the client turn. */
  readonly review: ((deadlineMs: number, stopTurn: () => void) => ReviewTurn) | null;
  /** 5.6: the provisioned configuration, checked before every turn with the project scan. */
  manifest: Manifest | null;
  /** 5.8: the only reader of a model-writable tree. */
  readonly collector: Collector;
}

/**
 * One owner turn, in its own process group under one deadline of at most 40 minutes, with its capture limits
 * (5.1). A Claude turn is refused before spawn unless its argv and both launch files hold (4.3); its effective
 * settings are read back over stdin before the prompt is written (4.4), and only when they hold is the prompt
 * sent, with stdin closed at the result event. A Codex turn has its stdin closed at spawn. After the group is
 * gone the attempt tree is checked for leftovers, and the turn must have added a held server launch (5.2).
 */
async function runClientTurn(o: Options, ctx: TurnCtx, prompt: string): Promise<TurnResult> {
  const bin = ctx.clientBin;
  let args: string[];
  let expected: ClaudeExpected | null = null;
  if (o.client === "claude") {
    if (ctx.claude === null) throw new Error("onboarding-eval: a Claude turn needs its launch");
    expected = launchExpected(ctx.claude);
    const session = { kind: ctx.first ? "first" as const : "resume" as const, id: ctx.sessionId ?? "" };
    args = claudeTurnArgs(expected, session);
    const weak = [
      ...claudeArgvProblems(args, expected, session),
      ...policyFileProblems(expected.policyFile, expected.policySha256, 0o400),
      ...policyFileProblems(expected.mcpFile, expected.mcpSha256, 0o600),
    ];
    if (weak.length > 0) throw new Error(`onboarding-eval: the turn's sandbox does not hold: ${weak.join("; ")}`);
  } else {
    args = turnArgs({ client: o.client, model: o.model, project: ctx.project, claudeArgs: [], sessionId: ctx.sessionId, first: ctx.first, writableRoots: ctx.writableRoots, serverEnv: ctx.serverEnv }, prompt);
    const weak = codexSandboxProblems(args, ctx.writableRoots, ctx.serverEnv);
    if (weak.length > 0) throw new Error(`onboarding-eval: the turn's sandbox does not hold: ${weak.join("; ")}`);
  }
  // 5.6, after the launch's own checks: what the client loads is checked before every turn; a change since provisioning, or a project that now
  // holds a name a client loads, is a harness stop before the turn.
  if (ctx.manifest !== null) {
    const held = [...configProblems(ctx.manifest), ...await ctx.collector.projectScan(ctx.project)];
    if (held.length > 0) throw new Error(`onboarding-eval: harness stop before the turn: ${held.join("; ")}`);
  }

  const deadlineMs = Math.min(o.timeoutMs, TURN_LIMITS.deadlineMs);
  const eventsBefore = fileSize(await collectedEvents(ctx.collector, ctx.host.events));
  const lines: string[] = [];
  let pending = "";
  let stderr = "";
  // One decoder per stream: a character split across two chunks is joined, never replaced.
  const outText = new StringDecoder("utf-8");
  const errText = new StringDecoder("utf-8");
  let control: GroupControl | null = null;
  let settled = false;
  let resultSeen = false;
  let promptWritten = false;
  const answers = new Map<string, { subtype: string; response?: unknown; error?: unknown }>();
  const waiters = new Map<string, (r: { subtype: string; response?: unknown; error?: unknown } | null) => void>();
  const line = (text: string): void => {
    let v: unknown;
    try { v = JSON.parse(text); } catch { lines.push(text); return; }
    const ev = v as { type?: unknown; response?: { request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown } };
    if (ev !== null && typeof ev === "object" && ev.type === "control_response") {
      const r = ev.response;
      const id = typeof r?.request_id === "string" ? r.request_id : null;
      if (id === null || answers.has(id)) return;
      const answer = { subtype: String(r?.subtype), response: r?.response, error: r?.error };
      answers.set(id, answer);
      waiters.get(id)?.(answer);
      return;
    }
    lines.push(text);
    if (ev !== null && typeof ev === "object" && ev.type === "result" && !resultSeen) {
      resultSeen = true;
      control?.endInput();
    }
  };
  // Past a limit the capture stops appending and the group is stopped once (5.1); never a throw from a data callback.
  const capture = new TurnCapture(ctx.host.capture, () => { (control as GroupControl | null)?.stop(); });
  const run = runInGroup({
    command: bin, args, cwd: ctx.project, env: ctx.env, timeoutMs: deadlineMs, killGraceMs: TURN_LIMITS.graceMs,
    onStdout: (c) => {
      const kept = capture.take("stdout", c);
      if (kept.length === 0) return;
      pending += outText.write(kept);
      let nl = pending.indexOf("\n");
      while (nl !== -1) { line(pending.slice(0, nl)); pending = pending.slice(nl + 1); nl = pending.indexOf("\n"); }
    },
    onStderr: (c) => { const kept = capture.take("stderr", c); if (kept.length > 0) stderr += errText.write(kept); },
    // Both clients get the stop handle; a Codex turn's input is closed at once.
    control: (c: GroupControl) => { control = c; if (expected === null) c.endInput(); },
  }).finally(() => {
    settled = true;
    for (const w of waiters.values()) w(null);
  });

  // 5.5: the review side lives for the turn; a request folder failure stops the client.
  const review = ctx.review?.(deadlineMs, () => { (control as GroupControl | null)?.stop(); }) ?? null;
  let launch: string | null = null;
  let readback: TurnResult["readback"] = null;
  if (expected !== null) {
    const io: ReadbackIo = {
      write: (l) => { (control as GroupControl | null)?.write(Buffer.from(l)); },
      response: (id, ms) => new Promise((done) => {
        const got = answers.get(id);
        if (got !== undefined) { done(got); return; }
        if (settled) { done(null); return; }
        const t = setTimeout(() => { waiters.delete(id); done(null); }, ms);
        waiters.set(id, (r) => { clearTimeout(t); waiters.delete(id); done(r); });
      }),
    };
    const rb = await claudeReadback(io, readbackExpected(expected), o.readbackTimeoutMs);
    // Any difference: no prompt, the group is stopped, and the turn is the launch failure naming the field.
    if (rb.problems.length > 0) {
      launch = rb.problems[0]!;
      (control as GroupControl | null)?.stop();
    } else {
      // The prompt counts as sent only when the input was still open for it.
      if (!resultSeen && !settled) promptWritten = true;
      (control as GroupControl | null)?.write(Buffer.from(userMessage(prompt)));
    }
    readback = { steps: rb.steps, mcpTools: [...expected.mcpTools], permissionDenials: null };
  }
  const r = await run;
  // 5.5: stopped and awaited, whatever ended the turn, before the leftover check.
  const reviewEnd = review === null ? null : await review.end();
  pending += outText.end();
  stderr += errText.end();
  if (pending !== "") line(pending);
  const raw = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  // A write refused only because the result already ended the input owes nothing once the prompt went out; a refused prompt write is a failure.
  const inputError = r.inputError === undefined || (r.inputError === "write after endInput" && promptWritten) ? null : r.inputError;
  // 5.1: after the group is gone, any process still holding a file or a working directory under the tree is a leftover.
  const leftover = leftoverCheck(ctx.host.tree);
  // 5.2: the server launches this turn added. Every one must be held with the pinned inventory, and a turn
  // with none ran no sandboxed storybloq server (serverLaunchFailure, the predicate the regrade replays).
  const launchLines = serverLaunchLines(readFrom(await collectedEvents(ctx.collector, ctx.host.events), eventsBefore));
  const launches = launchLines.map((l) => l.attempt);
  const servers = launchLines.filter((l) => launchHeld(l, ctx.host.toolsSha256)).map((l) => l.attempt);
  if (launch === null) launch = serverLaunchFailure(launchLines, ctx.host.toolsSha256);
  const facts = (t: EvalTurn, l: string | null): TurnFailureFacts => ({
    spawnError: r.spawnError, launch: l, inputError, limit: capture.exceeded, review: reviewEnd?.failure ?? null, timedOut: r.timedOut, timeoutMs: deadlineMs, outcome: processOutcome(r.exitCode, r.signal, false),
    terminal: t.terminal,
    // An unconfirmed stop of the review worker or a served command is the turn's unconfirmed cleanup.
    cleanup: r.cleanup === "confirmed" && (reviewEnd?.cleanup ?? "confirmed") === "confirmed" ? "confirmed" : "unconfirmed",
    cleanupDetail: r.cleanup !== "confirmed" ? r.cleanupDetail : reviewEnd?.cleanupDetail ?? null,
    leftover,
  });
  let turn: EvalTurn;
  if (o.client === "claude") {
    const events = parseStream(raw).events;
    turn = claudeTurn(events, CHECK_SET_VERSION);
    // A resumed print-mode session can come back under a new id; the next turn resumes whichever id this one reported.
    if (turn.sessionId) ctx.sessionId = turn.sessionId;
    const result = events.find((e) => e.type === "result") as { permission_denials?: unknown } | undefined;
    readback = { ...readback!, permissionDenials: result?.permission_denials ?? null };
    // The stream's own init event: permission mode, key source, server and tools. It is consulted by the same
    // predicate the regrade replays (initEventConsulted) on the failure this turn would record without it, so
    // only when nothing failed, or the failure is terminal or cleanup: spawn, input, timeout, signal and a
    // non-zero exit all rank above those, so each of them skips it. An undelivered prompt (input) says nothing.
    if (launch === null && initEventConsulted(turnInfraFailure(facts(turn, null)), r.exitCode)) {
      launch = initEventProblems(events as unknown as Record<string, unknown>[], expected!.mcpTools)[0] ?? null;
    }
  } else {
    const parsed: Record<string, unknown>[] = [];
    for (const l of raw.split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") parsed.push(v); } catch { /* non-JSON line */ } }
    turn = codexTurn(parsed, CHECK_SET_VERSION);
    if (ctx.first && turn.sessionId) ctx.sessionId = turn.sessionId;
    if (ctx.sessionId && typeof ctx.env.CODEX_HOME === "string") turn = { ...turn, models: codexRolloutModels(rolloutLines(await ctx.collector.copy("rollouts", join(ctx.env.CODEX_HOME, "sessions")), ctx.sessionId)) };
  }
  ctx.first = false;
  const infraFailure = turnInfraFailure(facts(turn, launch));
  const ended = facts(turn, launch);
  // T-538 commit 4 (7.3): every turn's findings reach the runner result, whatever the run does after it.
  // T-538 commit 4 round 2 (T5): the cleanup finding is the group's end AND the leftover check. A leftover or a
  // failed leftover check is an unconfirmed cleanup with its reason, whatever else ended the turn.
  const { cleanup, cleanupDetail } = turnCleanup(ended, leftover);
  progress.turns.push({ turn: progress.turns.length + 1, infraFailure, cleanup, cleanupDetail });
  return { turn, raw, stderr, exitCode: r.exitCode, infraFailure, readback, cleanup, host: { launches, servers, leftover: { status: leftover.status, reason: leftover.reason }, limit: capture.exceeded, review: reviewEnd?.failure ?? null } };
}

/** The collector's copy of the events log's folder, and the log's path in it (5.8). */
async function collectedEvents(c: Collector, eventsFile: string): Promise<string> {
  return join(await c.copy("events", dirname(eventsFile)), basename(eventsFile));
}

/** A runner-owned copy's size; 0 when it is absent. */
function fileSize(copy: string): number {
  return existsSync(copy) ? statSync(copy).size : 0;
}

/** The bytes a file gained past `offset`, as text; empty when it is missing or did not grow. */
function readFrom(file: string, offset: number): string {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  if (size <= offset) return "";
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
  return buf.toString("utf-8");
}

/**
 * T-538 commit 4 round 2 (T5): a turn's cleanup finding. Confirmed only when the group's end is confirmed AND the
 * leftover check is clean; a leftover or a failed leftover check is unconfirmed with its reason, whatever else
 * (a timeout, an exit) ended the turn.
 */
export function turnCleanup(ended: { readonly cleanup: "confirmed" | "unconfirmed"; readonly cleanupDetail?: string | null }, leftover: { readonly status: string; readonly reason: string | null }): { readonly cleanup: "confirmed" | "unconfirmed"; readonly cleanupDetail: string | null } {
  const dirty = leftover.status !== "clean";
  const parts = [ended.cleanup === "confirmed" ? null : ended.cleanupDetail ?? "the turn's process group was not confirmed gone", dirty ? `leftover check ${leftover.status}: ${leftover.reason}` : null].filter((x): x is string => x !== null);
  return { cleanup: ended.cleanup === "confirmed" && !dirty ? "confirmed" : "unconfirmed", cleanupDetail: parts.length === 0 ? null : parts.join("; ") };
}

/** What decides a turn's infrastructure failure: the group's result, the launch check, the limits, the parsed terminal and the leftover check. */
export interface TurnFailureFacts {
  readonly spawnError: string | null;
  readonly launch: string | null;
  readonly inputError: string | null;
  /** 5.1: the capture limit the turn passed (`limit: ...`), or null. */
  readonly limit: string | null;
  /** 5.5: the request folder's failure (`review requests: ...`), or null; ranked after the limit. */
  readonly review?: string | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  /** The process result as read by its launch kind (Addendum B). */
  readonly outcome: ProcessOutcome;
  readonly terminal: { readonly status: string; readonly detail: string };
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly cleanupDetail: string | null;
  /** 5.1: the leftover check after the group is gone; null where none ran. */
  readonly leftover: LeftoverCheck | null;
}

/**
 * A turn's infrastructure failure, the first that holds: spawn failed, `launch: `, `input: `, the limit, the request folder's failure (5.5), timed
 * out, the process result's form (`killed by`, `exit`, or the wrapped form), terminal, then `cleanup: ` when the
 * group's end was not confirmed, and last `cleanup: ` naming a leftover or a failed leftover check. Null for a
 * clean turn.
 */
export function turnInfraFailure(f: TurnFailureFacts): string | null {
  if (f.spawnError !== null) return `spawn failed: ${f.spawnError}`;
  if (f.launch !== null) return `launch: ${f.launch}`;
  if (f.inputError !== null) return `input: ${f.inputError}`;
  if (f.limit !== null) return f.limit;
  if ((f.review ?? null) !== null) return f.review!;
  if (f.timedOut) return `timed out after ${f.timeoutMs} ms`;
  if (f.outcome.form !== null) return f.outcome.form;
  if (f.terminal.status !== "completed") return `terminal ${f.terminal.status}: ${f.terminal.detail}`;
  if (f.cleanup !== "confirmed") return `cleanup: ${f.cleanup}${f.cleanupDetail !== null ? `: ${f.cleanupDetail}` : ""}`;
  if (f.leftover !== null && f.leftover.status !== "clean") return `cleanup: ${f.leftover.reason}`;
  return null;
}

/** True when `p` is any of `roots` or lies under one. */
export function underAnyRoot(p: string, roots: readonly string[]): boolean {
  const at = resolve(p);
  return roots.some((r) => at === resolve(r) || at.startsWith(`${resolve(r)}${sep}`));
}

/** The opening turn: the fixture's opening prompt, invoking the skill the client's way. */
export function firstPromptFor(client: Client, openingText: string): string {
  const opening = openingText.trim();
  const invoke = client === "claude" ? "/story" : "$story";
  return opening.startsWith("/story") ? opening.replace(/^\/story/, invoke) : `${invoke} ${opening}`;
}

/** The raw `.story/` copy as bytes, for the regrade's manifest. */
export function diskStoryBytes(story: string): StoryBytes {
  return {
    exists: (rel) => existsSync(join(story, rel)),
    readBytes: (rel) => readFileSync(join(story, rel)),
    list: (rel) => readdirSync(join(story, rel)),
  };
}

/** The project's `.story/` on disk, for the checks after approval. */
export function diskReader(story: string): StoryReader {
  return {
    exists: (rel) => existsSync(join(story, rel)),
    read: (rel) => readFileSync(join(story, rel), "utf-8"),
    list: (rel) => readdirSync(join(story, rel)),
  };
}

/** T-538 commit 4 (7.3): where this process has got to, for its `--result` file. */
const progress = newProgress("args");

async function main(argv: readonly string[], admission?: StandInAdmission): Promise<void> {
  progress.stage = "args";
  const o = parseArgs(argv, admission);
  progress.stage = "preflight";
  // T-538 5.4: every run needs the pinned tool inventory before anything is built or spawned.
  const toolSetsFile = o.toolSets ?? TOOL_SETS_FILE;
  const toolSets = claudeToolSets(o.toolSets);
  const toolsSha256 = sha256(readFileSync(toolSetsFile));
  // 5.2: the codex executable every sandbox launch uses, resolved once from the runner's own PATH, never looked up again.
  const codexOnPath = resolveOnPath("codex", process.env.PATH ?? "");
  if (codexOnPath === null) throw new Error("onboarding-eval: codex is not on PATH; the tool server runs under its sandbox wrapper");
  const codexBin = realpathSync(codexOnPath);
  const codexVersion = spawnSync(codexBin, ["--version"], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 });
  if (codexVersion.status !== 0) throw new Error(`onboarding-eval: ${codexBin} --version failed`);
  assertSubscriptionAuthOnly(process.env, "onboarding-eval");
  if (!existsSync(join(PKG_ROOT, "dist", "mcp.js"))) throw new Error("onboarding-eval: dist/mcp.js is missing; build this checkout first");
  // 5.5: served reviews run this checkout's real CLI on the host.
  if (!existsSync(join(PKG_ROOT, "dist", "cli.js"))) throw new Error("onboarding-eval: dist/cli.js is missing; build this checkout first");
  // Check set 7: the evaluation bundle, rebuilt whenever its inputs changed.
  const evalBuild = CHECK_SET_VERSION >= 7 ? await buildEval(PKG_ROOT) : null;
  if (o.client === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("onboarding-eval: CLAUDE_CODE_OAUTH_TOKEN is required for a fresh Claude config");

  const fixtureDir = join(FIXTURES, o.fixture);
  const rubric = rubricFor(JSON.parse(readFileSync(join(fixtureDir, "rubric.json"), "utf-8")) as Record<string, unknown>, CHECK_SET_VERSION) as unknown as FixtureRubric;
  const script = ownerScript(readFileSync(join(fixtureDir, ownerScriptFile(fixtureDir, CHECK_SET_VERSION)), "utf-8"));
  const variant = baseVariant(o.variant);
  const afterPackage = packageTurns(variant, script);
  // A session variant's later turns are checked the same way, before anything is spawned.
  if (isSessionVariant(o.variant)) laterSessions(o.variant, "/story", sessionScript(readFileSync(join(fixtureDir, ownerScriptFile(fixtureDir, CHECK_SET_VERSION)), "utf-8")), "T-0"); // throws before anything is spawned when the variant's sections are missing
  const firstPrompt = firstPromptFor(o.client, readFileSync(join(fixtureDir, "opening-prompt.txt"), "utf-8"));

  const runId = `${o.client}-${o.fixture}-${o.variant}-${new Date().toISOString().replace(/[:.]/g, "")}`;
  progress.stage = "provision";
  progress.runId = runId;
  // 5.6: the attempt tree lives under the per-user temp folder, by its canonical path, with no ancestor a client loads from.
  mkdirSync(o.attemptBase, { recursive: true, mode: 0o700 });
  const work = realpathSync(mkdtempSync(join(o.attemptBase, "a-")));
  const ancestors = ancestorProblems(work);
  if (ancestors.length > 0) throw new Error(`onboarding-eval: the attempt tree's ancestors hold client configuration: ${ancestors.join("; ")}`);
  const project = materializeFixture(o.fixture, work);
  // R2 (a): the fixture's declared dependencies, from its lockfile, before any turn and outside the sandbox.
  const dependencyInstalls = installFixtureDependencies(project, join(work, "npm-provision"), join(FIXTURES, o.fixture, "lockfiles"));
  const rawDir = join(o.rawOut, runId);
  mkdirSync(rawDir, { recursive: true });
  progress.rawDir = rawDir;

  // The real Codex auth is located before anything else; nothing else of the real homes is used.
  const realCodexAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const globalDir = join(work, "storybloq-global");
  // Check set 6 (T-536): the setup reviewer's store, per run, so rule 2 reads this run's revisions only.
  // The name carries the default store's prefix, so a turn that touches it reads as touching the store in a replay too.
  const setupReviewStore = join(work, "storybloq-setup-review-store");
  // Check set 7: every storybloq process appends to one events log, outside the project.
  const eventsFile = join(work, "eval-events", "events.jsonl");
  mkdirSync(dirname(eventsFile), { recursive: true });
  // The client binary is resolved on the ORIGINAL path, before any filtering below touches PATH.
  const clientBin = resolveOnPath(o.client, process.env.PATH ?? "");
  if (clientBin === null) throw new Error(`onboarding-eval: ${o.client} is not on PATH`);
  // Refreshes and config writes (the skill copies, ~/.claude, ~/.agents, ~/.codex) land in a scratch HOME for both clients.
  const home = join(work, "client-home");
  mkdirSync(home, { recursive: true });
  // ISS-1455: the attempt's temp folder is its own, under the one attempt tree, and writable by name.
  const attemptTmp = join(work, "tmp");
  mkdirSync(attemptTmp, { recursive: true });
  // 5.2: the wrapper's own CODEX_HOME (empty: no configuration, no credential) and the folder the server's self-probe tries.
  const runnerHome = join(work, "sandbox-runner-home");
  const outsideProbe = join(work, "outside-probe");
  mkdirSync(runnerHome);
  mkdirSync(outsideProbe);
  // 5.5: served reviews. Requests land in the model-writable events folder; answers in a folder outside every root.
  const reviewRequests = join(dirname(eventsFile), "review-requests");
  const reviewResponses = join(work, "review-responses");
  mkdirSync(reviewResponses, { mode: 0o700 });
  const served = provisionReviewer(work, realCodexAuth, variant, codexBin);
  const reviewerEnv: NodeJS.ProcessEnv = {
    PATH: `${served.bin}${delimiter}/usr/bin${delimiter}/bin`, HOME: served.home, CODEX_HOME: join(served.home, ".codex"),
    STORYBLOQ_SETUP_REVIEW_DIR: setupReviewStore, STORYBLOQ_GLOBAL_DIR: globalDir, TMPDIR: served.tmp, LANG: process.env.LANG || "en_US.UTF-8",
  };
  const servedLines: ServedLine[] = [];
  let turnEndsAt = 0;
  const reviewServer = new ReviewServer({
    requests: reviewRequests, responses: reviewResponses, project, store: setupReviewStore, budget: new ReviewBudget(),
    // Compared in memory by the scan, never stored or logged.
    secrets: [process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""].filter((x) => x.length >= 16),
    deadlineMs: () => Math.max(0, Math.min(SERVED_DEADLINE_MS, turnEndsAt - Date.now() - TURN_LIMITS.graceMs)),
    serve: serveReviewCommand(join(PKG_ROOT, "dist", "cli.js"), project, reviewerEnv),
    log: (l) => servedLines.push(l),
  });
  const startReview = (deadlineMs: number, stopTurn: () => void): ReviewTurn => {
    turnEndsAt = Date.now() + deadlineMs;
    return new ReviewTurn({
      // The worker outlives the turn's own stop (deadline, grace, then the kill and its confirmation), so a turn that
      // times out is recorded as timed out, never as an exited worker; end() stops the worker in every case.
      server: reviewServer, timeoutMs: deadlineMs + 2 * TURN_LIMITS.graceMs + WORKER_MARGIN_MS, onFailure: stopTurn,
      worker: {
        command: process.execPath, args: [...process.execArgv, join(PKG_ROOT, "scripts", "onboarding-eval-collect.ts"), "requests", reviewRequests], cwd: served.tmp,
        env: { PATH: `/usr/bin${delimiter}/bin`, HOME: served.tmp, TMPDIR: served.tmp, LANG: process.env.LANG || "en_US.UTF-8" },
      },
    });
  };
  const launcher = installCliLauncher(join(work, "cli-bin"));
  let clientPath = `${dirname(launcher)}${delimiter}${scrubClientEnv(process.env).PATH ?? ""}`;
  // R1: the Python shims, first on the PATH, outside every root (checked below once the roots are named).
  const pythonShims = installPythonShims(join(work, "python-bin"), clientPath);
  if (pythonShims.length > 0) clientPath = `${join(work, "python-bin")}${delimiter}${clientPath}`;
  if (variant === "reviewer-unavailable") clientPath = pathWithout(clientPath, join(work, "bin"), hiddenReviewers(CHECK_SET_VERSION));
  // The roots the client's own tools may write (Claude's policy; Codex's workspace-write), and the server's: the same, with the project named.
  // Section 3 and 5.6: the same five roots for every client, its tools and the server; the client's home, its
  // configuration and the review store lie beside them.
  const claudeRoots = [project, join(project, ".git"), attemptTmp, globalDir, dirname(eventsFile)];
  const writableRoots = claudeRoots;
  const serverRoots = claudeRoots;
  const mcp = storybloqEntry(CHECK_SET_VERSION, "mcp");
  // 5.3: one environment table. The token is passed through and never read, logged or hashed.
  let envInputs: EnvInputs = {
    client: o.client, path: clientPath, home, tmp: attemptTmp, lang: process.env.LANG || "en_US.UTF-8",
    ...(o.client === "codex" ? { clientCodexHome: join(home, ".codex") } : { claudeConfigDir: join(work, "claude-config"), oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }),
    runnerHome, globalDir, events: eventsFile, fault: armedIn(o.schedule, 1)?.selector ?? null, faultId: armedIn(o.schedule, 1)?.id ?? null, reviewStore: setupReviewStore, outside: outsideProbe, tools: toolSetsFile, degraded: variant === "degraded",
    reviewResponses,
  };
  let env: NodeJS.ProcessEnv = envFor("client", envInputs);
  let serverEnv = envFor("server", envInputs);
  // F2: every client starts the server through a launcher that keeps exactly the server column's variables; the
  // client's own environment never reaches the wrapper or the server. It lies outside every root, read-only, and
  // its bytes are checked with the configuration before every turn. The names are fixed here; a variable the
  // column drops after session 1 is unset in both columns, so the launcher passes nothing for it.
  const serverLauncher = writeServerLauncher(work);
  if (underAnyRoot(serverLauncher, serverRoots)) throw new Error(`onboarding-eval: ${serverLauncher} is under a writable root`);
  const launch = serverLaunch(codexBin, process.execPath, mcp.path, serverRoots, serverLauncher, Object.keys(serverEnv));
  let claudeLaunch: ClaudeLaunch | null = null;
  for (const f of pythonShims) if (underAnyRoot(f, writableRoots)) throw new Error(`onboarding-eval: ${f} is under a writable root`);
  const manifestEntries: ConfigEntry[] = [fileEntry(serverLauncher), ...pythonShims.map((f) => fileEntry(f))];
  if (o.client === "claude") {
    const claudeConfig = provisionClaude(work);
    if (claudeConfig.configDir !== envInputs.claudeConfigDir) throw new Error("onboarding-eval: the Claude config folder is not the provisioned one");
    manifestEntries.push(...claudeConfig.entries);
    // ISS-1463: no bypass. The policy file (4.1) and the MCP file are written once, outside every root, and
    // checked byte for byte before every turn; Agent and Task are denied by the policy in every variant.
    const policyFile = join(work, "claude-policy.json");
    const mcpFile = join(work, "mcp.json");
    for (const f of [policyFile, mcpFile]) if (underAnyRoot(f, claudeRoots)) throw new Error(`onboarding-eval: ${f} is under a writable root`);
    const policyText = claudePolicySettings(claudeRoots, allowedToolsOf(toolSets));
    writeFileSync(policyFile, policyText, { mode: 0o400, flag: "wx" });
    if (JSON.stringify(mcp.args) !== JSON.stringify(["--entry", "mcp"])) throw new Error("onboarding-eval: the evaluation entry's arguments are not --entry mcp");
    const mcpLaunch = { command: launch.command, args: [...launch.args] };
    const mcpText = claudeMcpText(mcpLaunch, serverEnv);
    writeClaudeMcpFile(mcpFile, mcpText);
    claudeLaunch = {
      model: o.model, policyFile, policySha256: sha256(policyText), mcpFile, mcpSha256: sha256(mcpText), mcpLaunch, project, roots: claudeRoots, toolSets, maxBudgetUsd: o.maxBudgetUsd,
    };
    // A Codex reviewer the model launches from its shell gets auth and nothing else; it finds it at HOME/.codex.
    manifestEntries.push(...provisionCodexHome(home, realCodexAuth, "reviewer", variant).entries, fileEntry(policyFile), fileEntry(mcpFile));
  } else {
    const codex = provisionCodexHome(home, realCodexAuth, "client", variant, { launch, tools: allowedToolsOf(toolSets), project });
    if (codex.codexHome !== envInputs.clientCodexHome) throw new Error("onboarding-eval: the Codex home is not the provisioned one");
    manifestEntries.push(...codex.entries);
  }
  // Finding 4 (pen ruling, option A): the CLI's own housekeeping writes the client home on its first ordinary
  // command (the storybloq hooks in settings.json, a stale skill copy). That write is provisioning: the harness's
  // own CLI runs once here, with the client's environment, before the manifest pins the client home. Its fault
  // variables are left out and its events go to a file of its own, so it is never a turn's invocation.
  const homeFolders = o.client === "claude" ? [home, envInputs.claudeConfigDir!] : [home];
  const provisionCwd = join(work, "cli-provision");
  mkdirSync(provisionCwd);
  const clientHomeProvisioning = provisionClientHome({
    command: launcher, folders: homeFolders, provisionDir: provisionCwd, root: work,
    version: (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8")) as { version: string }).version, skillSource: join(PKG_ROOT, "src", "skill"),
    markers: o.client === "claude" ? ["claude"] : ["codex"],
    markerWriter: { command: process.execPath, args: [...process.execArgv, join(PKG_ROOT, "scripts", "onboarding-eval-skill-marker.ts")] },
    env: { ...envFor("client", { ...envInputs, fault: null, faultId: null }), STORYBLOQ_EVAL_EVENTS: join(work, "provision-events.jsonl") },
  });
  manifestEntries.splice(0, manifestEntries.length, ...pinWrites(manifestEntries, clientHomeProvisioning, work));
  // 5.6: the configuration the client loads, checked before every turn; the project scanned before the first.
  // R1: the shim folder is listed in full, so anything else placed in it (it is first on the PATH) stops the run.
  const shimFolders = pythonShims.length > 0 ? [join(work, "python-bin")] : [];
  const manifest: Manifest = { folders: [...homeFolders, ...shimFolders], entries: manifestEntries };
  const configNow = configProblems(manifest);
  if (configNow.length > 0) throw new Error(`onboarding-eval: the provisioned configuration does not hold: ${configNow.join("; ")}`);
  const collector = new Collector(work);
  const scanned = await collector.projectScan(project);
  if (scanned.length > 0) throw new Error(`onboarding-eval: the project holds what a client would load: ${scanned.join("; ")}`);
  const isolation = isolationProblems(env, work, o.client, envFor("client", envInputs));
  if (isolation.length > 0) throw new Error(`onboarding-eval: client environment is not isolated: ${isolation.join("; ")}`);
  // What a shell under this environment actually resolves, recorded with the run.
  const effective = spawnSync("/bin/sh", ["-c", 'printf "%s\\n%s\\n%s\\n" "$HOME" "${CODEX_HOME-}" "${CLAUDE_CONFIG_DIR-}"'], { env, encoding: "utf-8" }).stdout.split("\n");
  const effectivePaths = { home: effective[0] ?? "", codexHome: effective[1] ?? "", claudeConfigDir: effective[2] ?? "" };
  if (effectivePaths.home !== env.HOME || effectivePaths.codexHome !== (env.CODEX_HOME ?? "")) throw new Error(`onboarding-eval: effective paths differ from the provisioned ones: ${JSON.stringify(effectivePaths)}`);
  if (variant === "reviewer-unavailable") {
    // Only the evaluated model's shell loses `codex`; the client itself runs from clientBin and the server's wrapper from codexBin.
    for (const name of hiddenReviewers(CHECK_SET_VERSION)) {
      const probe = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { env, encoding: "utf-8" });
      if (probe.status === 0) throw new Error(`onboarding-eval: ${name} is still on the eval PATH (${probe.stdout.trim()})`);
    }
  }
  const resolvedCli = spawnSync("/bin/sh", ["-c", "command -v storybloq"], { env, encoding: "utf-8" }).stdout.trim();
  if (resolvedCli !== launcher) throw new Error(`onboarding-eval: storybloq resolves to ${resolvedCli || "nothing"}, not this checkout's launcher ${launcher}`);
  const identity = {
    ...buildIdentity(), clientBin, cliLauncher: launcher, effectivePaths, codexReviewerAuth: existsSync(join(home, ".codex", "auth.json")),
    codexBin, codexVersion: codexVersion.stdout.trim(), toolSetsSha256: toolsSha256,
    ...(evalBuild !== null ? { evalInputDigest: evalBuild.digest } : {}),
  };

  // 5.9: monitoring only, compared after every turn; a change stops the matrix.
  const canary = makeCanary(join(work, "canary"));
  const before = await collector.digest(project);
  const exclusion = runtimeExclusion(project);
  const ctx: TurnCtx = {
    project, env, serverEnv, clientBin, writableRoots, claude: claudeLaunch, sessionId: o.client === "claude" ? randomUUID() : null as string | null, first: true,
    host: { tree: work, events: eventsFile, toolsSha256, capture: { used: 0 } }, review: startReview, manifest, collector,
  };
  const hostChecks: TurnHostChecks[] = [];
  // T-538 commit 1: each Claude turn's readback, a replay input with the tool set its launch expected.
  const readbacks: { readonly path: string; readonly sha256: string; readonly mcpTools: readonly string[] }[] = [];
  const state = newDriveState(CHECK_SET_VERSION);
  let turnNo = 0;
  progress.stage = "turns";
  // The owner's side of the conversation; each step spawns one turn and records its raw output.
  // T-538 S5a: the session variants' later sessions and what the harness does and sees around them.
  const session = isSessionVariant(o.variant) ? o.variant : null;
  const facts: { -readonly [K in keyof HarnessFacts]: HarnessFacts[K] } = { ...NO_FACTS, fault: o.fault, schedule: o.schedule === null ? null : [] };
  const observations: EvidenceObservation[] = [];
  const snapshotFile = `${eventsFile}.setup-snapshot.json`;
  // 5.8: the setup snapshot as the collector last copied it, refreshed after every turn of the variant that reads it.
  let snapshotCopy: string | null = null;
  const snapshotTickets = (): readonly object[] => (snapshotCopy !== null ? cs7SnapshotLedger(snapshotCopy).tickets : []);
  const refreshSnapshot = async (): Promise<void> => {
    const copy = join(dirname(await collectedEvents(collector, eventsFile)), basename(snapshotFile));
    snapshotCopy = existsSync(copy) ? readFileSync(copy, "utf-8") : null;
  };
  const later = session === null ? undefined : () => {
    if (isDemoVariant(session)) facts.dependent = rubric.followUp === undefined ? null : gatedTicket(snapshotTickets(), rubric.followUp.checkpoint);
    return laterSessions(session, o.client === "claude" ? "/story" : "$story", sessionScript(readFileSync(join(fixtureDir, ownerScriptFile(fixtureDir, CHECK_SET_VERSION)), "utf-8")), facts.dependent, o.schedule?.length ?? 1);
  };
  // The harness's own CLI calls log to their own file, never the run's events, and never carry a fault.
  // 5.7: every harness command on the project runs under the sandbox wrapper with the five roots, in its own group,
  // with an environment of its own: the wrapper's empty CODEX_HOME and no client credential.
  // Its HOME is a folder of its own under the tmp root, so nothing it writes lands in the client's home (5.6).
  const harnessHome = join(attemptTmp, "harness-home");
  mkdirSync(harnessHome, { recursive: true, mode: 0o700 });
  const sandboxEnv = (): NodeJS.ProcessEnv => ({
    PATH: envInputs.path, HOME: harnessHome, TMPDIR: envInputs.tmp, LANG: envInputs.lang, CODEX_HOME: runnerHome, STORYBLOQ_CLIENT: envInputs.client,
    STORYBLOQ_GLOBAL_DIR: envInputs.globalDir, STORYBLOQ_SETUP_REVIEW_DIR: envInputs.reviewStore, STORYBLOQ_EVAL_EVENTS: join(work, "eval-events", "harness-events.jsonl"),
  });
  const wrappedForm = (r: SandboxedRun): { killedBy?: string; exitForm?: string } => {
    const w = processOutcome(r.status, r.signal, true);
    return w.killedBy !== null && w.form !== null && r.signal === null ? { killedBy: w.killedBy, exitForm: w.form } : {};
  };
  const inSandbox = async (command: string): Promise<SandboxedRun> => stopUnconfirmed(await sandboxedRun({ codexBin, roots: writableRoots, cwd: project, command, deadlineMs: HARNESS_DEADLINE_MS, env: sandboxEnv() }), command);
  const harnessCli = async (args: readonly string[]): Promise<string> => {
    const r = await inSandbox(shellWords([launcher, ...args]));
    if (r.status !== 0) throw new Error(`onboarding-eval: harness step storybloq ${args.join(" ")} failed (${r.status ?? r.signal}): ${r.stderr.trim()}`);
    return r.stdout;
  };
  let current = 1;
  // 6.1: interrupted-edited's baseline, the project as the collector copied it straight after the owner's edits.
  let editedSnapshot: string | null = null;
  // 6.2: milestone-states' boundary records, each computed from its own collector copy, and the copies' pins.
  const states: StateRecord[] = [];
  const stateInputs: ManifestEntry[] = [];
  const captureState = async (at: string): Promise<void> => {
    const n = states.length;
    stateInputs.push(...copyStateParts(await collector.copy("ledger", join(project, ".story")), rawDir, n));
    states.push(await stateRecord(join(rawDir, stateDir(n)), at, rubric.followUp?.checkpoint ?? null, facts.dependent));
  };
  const beforeTurn = async (n: number, label: string): Promise<void> => {
    if (session === null) return;
    if (n !== current) {
      // A fresh client: no resume, a new session id.
      ctx.sessionId = o.client === "claude" ? randomUUID() : null;
      ctx.first = true;
      // 6.1: the entry armed in the session that ended is recorded by its own marker; the next session's entry, if any, is armed.
      const ended = armedIn(o.schedule, current);
      if (ended !== null) {
        const fact = scheduleFact(ended, eventsFile);
        facts.schedule = [...(facts.schedule ?? []), fact];
        if (current === 1) facts.fired = fact.fired;
      }
      if (ended !== null || armedIn(o.schedule, n) !== null) {
        // 5.3: the fault variables follow the schedule into both columns; Claude's MCP file is rewritten and its sha256 updated before the next turn.
        const next = armedIn(o.schedule, n);
        envInputs = { ...envInputs, fault: next?.selector ?? null, faultId: next?.id ?? null };
        env = envFor("client", envInputs);
        serverEnv = envFor("server", envInputs);
        ctx.env = env;
        ctx.serverEnv = serverEnv;
        if (ctx.claude !== null) {
          const text = claudeMcpText(ctx.claude.mcpLaunch, serverEnv);
          writeClaudeMcpFile(ctx.claude.mcpFile, text);
          ctx.claude = { ...ctx.claude, mcpSha256: sha256(text) };
          // F11: the manifest's entry for the MCP file follows the rewrite, so the check before the next turn holds it.
          const mcpFile = ctx.claude.mcpFile;
          if (ctx.manifest !== null) ctx.manifest = { ...ctx.manifest, entries: ctx.manifest.entries.map((e) => (e.kind === "file" && e.path === mcpFile ? fileEntry(mcpFile) : e)) };
        }
      }
      if (current === 1) {
        if (session === "interrupted-edited") {
          const edits = ownerEdits(cs7FinalLedger(diskReader(await collector.copy("ledger", join(project, ".story")))).tickets);
          if (edits !== null) {
            await harnessCli(["ticket", "update", edits.edgeTicket, "--add-blocked-by", edits.blocker]);
            await harnessCli(["ticket", "update", edits.describedTicket, "--description", edits.description]);
          }
          facts.edits = edits;
          editedSnapshot = await collector.snapshot(project);
        }
        if (session === "restart") {
          const events = await collectedEvents(collector, eventsFile);
          const id = setupIdOf(readEventsLog(existsSync(events) ? readFileSync(events, "utf-8") : null).log);
          facts.report = id === null ? null : (await harnessCli(["setup-report", "--setup", id])).split("\n").map((l) => l.trim()).filter((l) => l !== "");
        }
      }
      current = n;
    }
    if (isDemoVariant(session) && label === "demo-approval") {
      const demo = rubric.demo;
      if (demo !== undefined) {
        const r = await inSandbox(demo.command);
        facts.demo = demoFacts(demo.command, demo.stdout, { status: r.status, signal: r.signal, stdout: r.stdout, ...wrappedForm(r), ...(r.spawnError !== null ? { error: new Error(r.spawnError) } : {}), ...(r.timedOut ? { error: new Error(`timed out after ${HARNESS_DEADLINE_MS} ms`) } : {}) });
      }
    }
    if (isDemoVariant(session) && n >= 2) observations.push(...await collector.observe(project, { kind: "turn", index: state.turns.length }));
    if (session === "milestone-states" && n >= 2) await captureState(label);
  };
  // T-538 commit 4 (section 8 step 3): the Claude arm's probe turn. One fixed prompt under the policy and readback
  // of any turn, in this provisioned attempt; its facts go to the runner result and the driver applies the rule.
  if (o.probeTurn !== null) {
    const facts = await runProbeTurn({
      node: process.execPath,
      targets: { roots: claudeRoots, outsideProbe, home, tmp: "/tmp", canary: join(work, "canary"), reportDir: dirname(eventsFile), probeDir: join(work, "probe"), insideDir: project },
      turn: async (prompt) => {
        const r = await runClientTurn(o, ctx, prompt);
        writeFileSync(join(rawDir, "turn-01-probe.jsonl"), r.raw);
        writeFileSync(join(rawDir, "turn-01-probe.stderr.txt"), r.stderr);
        return { raw: r.raw, infraFailure: r.infraFailure, permissionDenials: r.readback?.permissionDenials ?? null, cleanup: r.cleanup };
      },
    });
    progress.probe = { ...facts, turnProblems: [...facts.turnProblems, ...canaryProblems(canary)] };
    process.exitCode = 0;
    return;
  }
  const flow = driveFlow({ variant, firstPrompt, discoveryPrompt: script.discovery, afterPackage, exclusion, ...(later !== undefined ? { later } : {}) }, state);
  for (let step = flow.next(); !step.done;) {
    const request = step.value;
    await beforeTurn(request.session ?? 1, request.label);
    const r = await runClientTurn(o, ctx, request.prompt);
    const stem = join(rawDir, `turn-${String(++turnNo).padStart(2, "0")}-${request.label}`);
    hostChecks.push({ file: basename(stem), ...r.host });
    writeFileSync(`${stem}.jsonl`, r.raw);
    writeFileSync(`${stem}.stderr.txt`, r.stderr);
    if (r.readback !== null) {
      const text = `${JSON.stringify({ steps: r.readback.steps, permissionDenials: r.readback.permissionDenials }, null, 2)}\n`;
      writeFileSync(`${stem}.readback.json`, text);
      readbacks.push({ path: basename(`${stem}.readback.json`), sha256: sha256(text), mcpTools: r.readback.mcpTools });
    }
    const changed = canaryProblems(canary);
    if (changed.length > 0) throw new Error(`onboarding-eval: ${changed.join("; ")} after turn ${turnNo}; the matrix stops`);
    const after = await collector.digest(project);
    if (isDemoVariant(session)) await refreshSnapshot();
    const response: TurnResponse = { turn: r.turn, exitCode: r.exitCode, infraFailure: r.infraFailure, stderrPath: `${stem}.stderr.txt`, treeChanges: () => digestChanges(before, after, exclusion) };
    step = flow.next(response);
  }
  // The evidence as the last session left it.
  if (isDemoVariant(session)) observations.push(...await collector.observe(project, { kind: "turn", index: state.turns.length }));
  if (session === "milestone-states") await captureState("after-last");
  // T-538 S5b: then the harness's own ordinary status update on the gated dependent, which the checkpoint must refuse.
  if (isDemoVariant(session) && facts.dependent !== null) {
    facts.bypass = await attemptBypassAsync(() => collector.ledgerState(join(project, ".story")), facts.dependent, async (args) => {
      const r = await inSandbox(shellWords([launcher, ...args]));
      return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ...wrappedForm(r), ...(r.spawnError !== null ? { error: new Error(r.spawnError) } : {}), ...(r.timedOut ? { error: new Error(`timed out after ${HARNESS_DEADLINE_MS} ms`) } : {}) };
    });
  }
  // 5.8: the evidence as the collector copied it after the last turn and the harness's own steps.
  progress.stage = "collect";
  const storeCopy = await collector.copy("store", setupReviewStore);
  const eventsCopy = await collectedEvents(collector, eventsFile);
  const storyCopy = await collector.copy("ledger", join(project, ".story"));
  if (CHECK_SET_VERSION >= 6) {
    applySetupReviewChecks(state, storeCopy, variant, servedLines);
    // Always present for check set 6, empty when nothing ran, so a missing copy is a loss the regrade names.
    if (existsSync(storeCopy)) cpSync(storeCopy, join(rawDir, STORE_COPY), { recursive: true, verbatimSymlinks: true });
    else mkdirSync(join(rawDir, STORE_COPY));
  }
  let replayInputs: ManifestEntry[] = [];
  if (CHECK_SET_VERSION >= 7) {
    // The raw inputs are copied first, so the regrade reads exactly what the run graded.
    const events = existsSync(eventsCopy) ? readFileSync(eventsCopy) : null;
    const snapshot = existsSync(`${eventsCopy}.setup-snapshot.json`) ? readFileSync(`${eventsCopy}.setup-snapshot.json`) : null;
    if (events !== null) writeFileSync(join(rawDir, EVENTS_RAW), events);
    if (snapshot !== null) writeFileSync(join(rawDir, SNAPSHOT_RAW), snapshot);
    const story = storyCopy;
    const r = applySetupRunChecks(state, {
      eventsText: events === null ? null : events.toString("utf-8"),
      snapshotText: snapshot === null ? null : snapshot.toString("utf-8"),
      final: existsSync(story) ? cs7FinalLedger(diskReader(story)) : EMPTY_LEDGER,
      ...fixtureBaseline(fixtureDir, (rel) => readFileSync(join(fixtureDir, rel), "utf-8")),
      approval: afterPackage.find((x) => x.label === "approve")?.prompt ?? "",
      projectRoot: project,
      contract: recipeContract(rubric.expectedRecipe),
      observations: isDemoVariant(session) ? observations : null,
      followUp: followUpOf(rubric),
    });
    const invocations = invocationsText(project, r.invocations);
    writeFileSync(join(rawDir, INVOCATIONS_RAW), invocations);
    replayInputs = [
      ...(events !== null ? [{ path: EVENTS_RAW, sha256: sha256(events) }] : []),
      { path: INVOCATIONS_RAW, sha256: sha256(invocations) },
      ...(snapshot !== null ? [{ path: SNAPSHOT_RAW, sha256: sha256(snapshot) }] : []),
      ...readbacks.map((x) => ({ path: x.path, sha256: x.sha256 })),
    ];
    // 5.1 and 5.2: each turn's server launches, leftover check and limit, so the regrade replays every host failure.
    const hostText = hostChecksText(hostChecks, toolsSha256);
    writeFileSync(join(rawDir, HOST_CHECKS_RAW), hostText);
    replayInputs.push({ path: HOST_CHECKS_RAW, sha256: sha256(hostText) });
    // 5.5: the served commands, empty when none ran.
    const servedText = servedLinesText(servedLines);
    writeFileSync(join(rawDir, SERVED_RAW), servedText);
    replayInputs.push({ path: SERVED_RAW, sha256: sha256(servedText) });
    if (session !== null) {
      // 6.1: an entry whose session never ended (the attempt stopped inside it) is recorded here, after its session.
      for (const e of o.schedule ?? []) {
        if (facts.schedule?.some((f) => f.id === e.id)) continue;
        const fact = scheduleFact(e, eventsFile);
        facts.schedule = [...(facts.schedule ?? []), fact];
        if (e.session === 1) facts.fired = fact.fired;
      }
      const log = readEventsLog(events === null ? null : events.toString("utf-8")).log;
      // 6.1: a fault run's tree snapshots, each a replay input: the kill snapshot per fired record (as the
      // collector copied the events folder), the edited baseline, and the project at the end of the attempt.
      let faults: FaultSnapshots | undefined;
      if (session === "interrupted" || session === "interrupted-edited") {
        const named = new Map<string, string>();
        for (const f of log?.fired ?? []) if (existsSync(killSnapshot(eventsCopy, f.id))) named.set(killRaw(f.id), readFileSync(killSnapshot(eventsCopy, f.id), "utf-8"));
        if (editedSnapshot !== null) named.set(EDITED_RAW, editedSnapshot);
        named.set(END_RAW, await collector.snapshot(project));
        for (const [name, text] of named) {
          writeFileSync(join(rawDir, name), text);
          replayInputs.push({ path: name, sha256: sha256(text) });
        }
        faults = { read: (name) => named.get(name) ?? null, protectedPaths: [...protectedPathsOf(fixtureEvidence(join(fixtureDir, "project")).hashes), ...provisionedLockfiles(dependencyInstalls)].sort() };
      }
      const id = setupIdOf(log);
      if (session === "interrupted-edited") facts.storeRevisions = id === null ? 0 : storeRevisionCount(storeCopy, id);
      if (session === "empty-idea-verify") facts.testEnabled = existsSync(join(story, "config.json")) && (JSON.parse(readFileSync(join(story, "config.json"), "utf-8")) as { recipeOverrides?: { stages?: { TEST?: { enabled?: unknown } } } }).recipeOverrides?.stages?.TEST?.enabled === true;
      const sessionsFile = sessionsText({ sessions: sessionSpans(state.turns), harness: facts });
      writeFileSync(join(rawDir, SESSIONS_RAW), sessionsFile);
      replayInputs.push({ path: SESSIONS_RAW, sha256: sha256(sessionsFile) });
      if (isDemoVariant(session)) {
        const observed = observationsText(observations);
        writeFileSync(join(rawDir, OBSERVATIONS_RAW), observed);
        replayInputs.push({ path: OBSERVATIONS_RAW, sha256: sha256(observed) });
      }
      if (session === "milestone-states") {
        const text = statesText(states);
        writeFileSync(join(rawDir, STATES_RAW), text);
        replayInputs.push({ path: STATES_RAW, sha256: sha256(text) }, ...stateInputs);
      }
      applySessionChecks(state, {
        variant: session, harness: facts, log, mapping: r.invocations,
        tickets: existsSync(story) ? cs7FinalLedger(diskReader(story)).tickets : [],
        ticketsAtSetup: snapshot === null ? [] : cs7SnapshotLedger(snapshot.toString("utf-8")).tickets,
        present: (name) => existsSync(join(rawDir, name)),
        ...(faults !== undefined ? { faults } : {}),
        ...(session === "milestone-states" ? { states, followUpTitle: rubric.followUp?.titlePattern ?? null } : {}),
      });
    }
  }
  const { turns, failures, reviewSkipped } = state;
  const evidence = finishDrive(state, REVIEW_LINE);
  const { reviewEvidence, bound } = evidence;
  const semanticLines: string[] = runSemanticLines(reviewSkipped, turns, exclusion, afterPackage.some((x) => x.label === "adjust"), CHECK_SET_VERSION, evidence.reviewLines, evidence.judgeLines ?? []);

  const story = storyCopy;
  const { inspection, ledgerRecords } = inspectAfter(state, diskReader(story), rubric, () => JSON.parse(readFileSync(join(fixtureDir, "project", ".story", "config.json"), "utf-8")) as Record<string, unknown>, variant);

  // The fixture project as the owner supplied it (no .story): the briefs, and every other file as the
  // implementation evidence any "already built" or "working" claim must rest on.
  const { briefs, projectFiles } = fixtureEvidence(join(fixtureDir, "project"));

  const rolloutContext = ctx.sessionId !== null ? rolloutInstructions(rolloutLines(await collector.copy("rollouts", join(home, ".codex", "sessions")), ctx.sessionId)) : { status: "unknown" as const };
  const packetText = buildPacketText({
    runId, semanticLines, reviewSkipped, exclusion, rubric, briefs, projectFiles, turns, evidence, ledgerRecords,
    setupRecord: existsSync(story) ? setupRecordFrom(diskReader(story)) : "", final: state.final, checkSet: CHECK_SET_VERSION,
  });
  const verdict = runVerdict(failures, packetText, null, semanticLines, bound);
  const recordDir = join(o.out, runId);
  progress.recordDir = recordDir;
  mkdirSync(recordDir, { recursive: true });
  // F13: the judge refuses this record while the marker stands; only a clean scan below removes it.
  writeFileSync(join(recordDir, SCAN_PENDING_FILE), `${JSON.stringify({ pending: "the 5.9 scan has not cleared this record" })}\n`, { flag: "wx" });
  progress.stage = "record";
  await writeAtomic(join(recordDir, "record.json"), JSON.stringify({
    runId, client: o.client, fixture: o.fixture, variant: o.variant, modelRequested: o.model, checkSetVersion: CHECK_SET_VERSION,
    // T-538 commit 1 (plan 6.4): this route's record; the regrade re-runs each readback against claudeLaunch.
    route: "host-v2",
    // R2 (a): each lockfile the fixture ships, installed at provisioning.
    dependencyInstalls,
    clientHomeProvisioning,
    ...(claudeLaunch !== null ? {
      claudeLaunch: {
        project: claudeLaunch.project, roots: claudeLaunch.roots, policy: claudePolicyObject(claudeLaunch.roots, allowedToolsOf(claudeLaunch.toolSets)), mcpLaunch: claudeLaunch.mcpLaunch,
        toolSets: Object.fromEntries(readbacks.map((x) => [x.path, x.mcpTools])),
      },
    } : {}),
    modelsObserved: [...new Set(turns.flatMap((x) => x.models))], identity, treeExclusion: exclusion, turns, discoveryRounds: state.rounds, reviewSkipped, reviewEvidence,
    // 5.8: entries of the project or the rollouts the collector could not take, named; the run is scored without them.
    ...(collector.named.length > 0 ? { evidenceNamed: collector.named } : {}),
    writesAfterApproval: writesAfterApprovalOf(state), unparsed: evidence.unparsed, inspection, failures, infraFailed: state.infraFailed,
    semanticLines, bound, ...(evidence.reviewerCapability !== undefined ? { reviewerCapability: evidence.reviewerCapability } : {}),
    // Check set 5: the fixture contract's reviewer paths, citations outside the package, and the client's instruction context (B3).
    ...(CHECK_SET_VERSION >= 5 ? {
      reviewerInventory: inventoryFor(variant), skillCitations: evidence.skillCitations ?? [],
      instructionContext: rolloutContext,
    } : {}),
    // Check set 7: the raw inputs the regrade must find unchanged, each with its sha256.
    ...(CHECK_SET_VERSION >= 7 ? { replayInputs } : {}),
    packetSha256: sha256(packetText), verdict: verdict.verdict, finishedAt: new Date().toISOString(),
  }, null, 2));
  await writeAtomic(join(recordDir, "grading-packet.json"), packetText);
  const archived = await collector.archive(project, join(rawDir, "project.after"));
  for (const p of archived.problems) process.stderr.write(`archive: ${p}\n`);
  // 5.9: nothing reaches a model unscanned. The record, the packet and every raw input are scanned before the
  // judge can be handed the packet; a hit, an unreadable file or an oversize packet makes the attempt invalid.
  progress.stage = "scan";
  await scanAndClear(collector, recordDir, rawDir, Buffer.byteLength(packetText, "utf-8"), envInputs.oauthToken !== undefined ? [envInputs.oauthToken] : []);
  process.stdout.write(`${runId} ${verdict.verdict}\n${verdict.reasons.map((f) => `  - ${f}`).join("\n")}\n`);
  progress.verdict = verdict.verdict;
  // 0 only for a full PASS, which needs --finalize with a judge result; mechanical success alone is 3 (pending).
  process.exitCode = verdict.verdict === "FAIL" ? 1 : verdict.verdict === "PENDING_SEMANTIC" ? 3 : 0;
}

/** A fixture's rubric as the drive reads it, after the check set projection (lib `rubricFor`). */
type FixtureRubric = {
  class: string; expectedRecipe: ExpectedRecipe; scaffold?: { keepPhase: string; configUnchanged: string[] }; followUp?: FollowUp;
  /** T-538 S5a, milestone-demo: the command the harness runs after the milestone and the stdout it must print. */
  demo?: { command: string; stdout: string };
};

const EMPTY_LEDGER: Cs7FinalLedger = { tickets: [], issues: [], notes: [], phases: [], rulings: [] };

/** The fixture's own ledger before the run: its ticket and issue ids and its phases. `read` takes a path relative to the fixture. */
export function fixtureBaseline(fixtureDir: string, read: (rel: string) => string): { baselineIds: string[]; baselinePhases: string[] } {
  const story = join(fixtureDir, "project", ".story");
  if (!existsSync(story)) return { baselineIds: [], baselinePhases: [] };
  const ledger = cs7FinalLedger({ exists: (rel) => existsSync(join(story, rel)), read: (rel) => read(join("project", ".story", rel)), list: (rel) => readdirSync(join(story, rel)) });
  return { baselineIds: [...ledger.tickets, ...ledger.issues].map((x) => (x as { id: string }).id), baselinePhases: [...ledger.phases] };
}

/** The rubric's follow-up assertion (rule 9), or null when the fixture names none. */
export function followUpOf(rubric: { readonly followUp?: FollowUp }): FollowUp | null {
  return rubric.followUp ?? null;
}

/** invocations.json: the project root rule 10 resolved against, and each invocation's call. */
export function invocationsText(projectRoot: string, mapping: readonly InvocationMapping[]): string {
  return `${JSON.stringify({ projectRoot, mapping }, null, 2)}\n`;
}

/** The owner script a check set reads: check set 2 prefers `owner-answers.checkset-2.md` when the fixture has one. */
export function ownerScriptFile(fixtureDir: string, checkSet: number): string {
  return checkSet >= 2 && existsSync(join(fixtureDir, "owner-answers.checkset-2.md")) ? "owner-answers.checkset-2.md" : "owner-answers.md";
}

/** The semantic rubric lines only a judge can rule on; every run's packet asks for all of them. */
/** Asked only when an adjustment turn was sent (every variant but approval-boundary). */
export const ADJUSTMENT_LINE = "the package presented after the adjustment reflects the adjustment";

export const SEMANTIC_LINES = [
  "every question asked concerned a material gap the briefs left open, and none re-asked something the briefs or earlier answers settled",
  "every conflict between sources was surfaced with its consequence and a recommendation before planning depended on it",
  "the coverage map accounts for every requirement in the briefs and the answers: a ticket, an owner decision, or an explicit deferral",
  "the created tickets carry actionable acceptance and verification that fit the brief, with no invented approvals or capabilities",
  "every capability the setup described as already built, tested or working is backed by the fixture's projectFiles; nothing was claimed complete without that evidence",
] as const;

/**
 * Asked of every run where the owner did not skip review. The judge must cite
 * the reviewEvidence.beforeFirstPackage index (or indices) its ruling rests on,
 * and the verdict accepts only indices the packet offered.
 */
export const REVIEW_LINE = "the initial proposal received an independent review: a cited invocation from reviewEvidence.beforeFirstPackage was given the plan that became the first proposal (its input carries that plan) and returned a review of it; a help or version probe, an unrelated task, or a review of something else does not count";

/** After a material adjustment, when review is available. */
export const ADJUSTMENT_REVIEW_LINE = "a material change made in the adjustment was independently reviewed again before the adjusted package was shown";
/** After a material adjustment, when the owner explicitly skipped review. */
export const ADJUSTMENT_SKIP_LINE = "the owner's explicit skip of independent review was preserved and disclosed for the adjusted package: no review was claimed, and the package says it was not independently reviewed";

/** The semantic lines a run asks for: the review lines depend on whether the owner explicitly skipped review (packet.reviewSkipped). */
export function semanticLinesFor(reviewSkipped: boolean, adjusted = true): string[] {
  const adjustment = adjusted ? [ADJUSTMENT_LINE, ...(reviewSkipped ? [ADJUSTMENT_SKIP_LINE] : [ADJUSTMENT_REVIEW_LINE])] : [];
  return [...SEMANTIC_LINES.slice(0, 3), ...adjustment.slice(0, 1), ...SEMANTIC_LINES.slice(3), ...adjustment.slice(1), ...(reviewSkipped ? [] : [REVIEW_LINE])];
}

/**
 * Every line the judge must rule on for this run: the rubric, plus one per
 * semantic stop and, when tree exclusion was disabled, the tree line. Neither
 * of those is a mechanical result, so each needs a ruling (even with no change).
 */
export function runSemanticLines(
  reviewSkipped: boolean, turns: readonly { readonly label: string; readonly stop: Pick<StopCheck, "kind" | "candidate"> | null }[], exclusion: RuntimeExclusion, adjusted = true,
  checkSet = 1, reviewLines: readonly string[] = [], judgeLines: readonly string[] = [],
): string[] {
  return [
    ...semanticLinesFor(reviewSkipped, adjusted),
    ...turns.filter((x) => x.stop?.kind === "semantic").map((x) => semanticStopLine(x.label, x.stop!.candidate!)),
    ...(exclusion.source === "disabled" && turns.some((x) => x.stop !== null) ? [TREE_EXCLUSION_LINE] : []),
    // Check set 2: prose about the review agrees with the status lines, and each review binding and non-material declaration is ruled on.
    ...(checkSet >= 2 ? [REVIEW_STATEMENTS_LINE, ...reviewLines] : []),
    // Check set 4: each qualifying post-approval python script, and each package citing a review that did not approve.
    ...(checkSet >= 4 ? judgeLines : []),
  ];
}

/** Check set 2: the review outcome is stated only by the status line; any other statement about the review must agree with it. */
export const REVIEW_STATEMENTS_LINE = "every statement about the independent review in the packages and summary agrees with that turn's review status line and the captured reviewer evidence; nothing reports a review outcome the evidence does not show";

/**
 * The fixture's text files, split into briefs (prose documents) and everything else, each file capped for the packet,
 * with a hash of the exact bytes each representation was built from (`project/<path>`), for the regrade's manifest.
 */
export function fixtureEvidence(root: string, capBytes = 64 * 1024): { readonly briefs: Record<string, string>; readonly projectFiles: Record<string, string>; readonly hashes: readonly ManifestEntry[] } {
  const briefs: Record<string, string> = {};
  const projectFiles: Record<string, string> = {};
  const hashes: ManifestEntry[] = [];
  const collect = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".story" || name === ".gitkeep") continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) { collect(p, r); continue; }
      const bytes = readFileSync(p);
      hashes.push({ path: `project/${r}`, sha256: sha256(bytes) });
      const text = bytes.includes(0) ? `[binary, sha256 ${sha256(bytes)}]`
        : bytes.length > capBytes ? `${bytes.subarray(0, capBytes).toString("utf-8")}\n[truncated at ${capBytes} of ${bytes.length} bytes, sha256 ${sha256(bytes)}]`
        : bytes.toString("utf-8");
      if (/\.(md|txt|rst|adoc)$/i.test(name)) briefs[r] = text;
      else projectFiles[r] = text;
    }
  };
  collect(root, "");
  return { briefs, projectFiles, hashes };
}

/**
 * Why `packetText` is not this record's grading packet, or null when it is: the hash the run recorded, the run id and
 * the semantic lines must all match. Finalize and the judge runner (ISS-1348) share it.
 */
export function packetMismatch(record: Readonly<Record<string, unknown>>, packetText: string): string | null {
  if (typeof record.packetSha256 !== "string" || sha256(packetText) !== record.packetSha256) return "the grading packet on disk does not match the hash this run recorded";
  let packet: { runId?: unknown; semanticLines?: unknown };
  try { packet = JSON.parse(packetText) as typeof packet; } catch { return "the grading packet is not JSON"; }
  if (packet.runId !== record.runId) return `the grading packet is for run ${String(packet.runId)}, not ${String(record.runId)}`;
  const lines = record.semanticLines;
  if (!Array.isArray(lines) || JSON.stringify(lines) !== JSON.stringify(packet.semanticLines)) return "the packet's semantic lines differ from the record's";
  return null;
}

/**
 * Bind a judge result to a finished run. Refused, with nothing written, when
 * the packet on disk is not the one the run recorded (hash or run id differs)
 * or its semantic lines differ from the record's. PASS only when the
 * mechanical record was clean, the judge read this exact packet, named its
 * observed model, passed every semantic line and cited allowed evidence.
 */
export function finalizeRecord(
  record: Readonly<Record<string, unknown>>, packetText: string, judge: JudgeResult,
): { readonly ok: true; readonly verdict: RunVerdict; readonly record: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  const mismatch = packetMismatch(record, packetText);
  if (mismatch !== null) return { ok: false, reason: mismatch };
  const lines = record.semanticLines as string[];
  const failures = Array.isArray(record.failures) ? (record.failures as string[]) : ["the record has no failures list"];
  const bound = (record.bound ?? {}) as Record<string, number[]>;
  const verdict = runVerdict(failures, packetText, judge, lines as string[], bound);
  return { ok: true, verdict, record: { ...record, judge, verdict: verdict.verdict, verdictReasons: verdict.reasons, finalizedAt: new Date().toISOString() } };
}

/** `--finalize <recordDir> --judge <judge.json>`. Throws, writing nothing, when the record and packet do not belong together. */
export async function finalize(argv: readonly string[]): Promise<void> {
  progress.stage = "finalize";
  const at = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const recordDir = at("finalize"); const judgePath = at("judge");
  if (!recordDir || !judgePath) throw new Error("--finalize <recordDir> --judge <judge.json>");
  const record = JSON.parse(readFileSync(join(recordDir, "record.json"), "utf-8")) as Record<string, unknown>;
  const packetText = readFileSync(join(recordDir, "grading-packet.json"), "utf-8");
  const judge = JSON.parse(readFileSync(judgePath, "utf-8")) as JudgeResult;
  const r = finalizeRecord(record, packetText, judge);
  if (!r.ok) throw new Error(`onboarding-eval: finalize refused for ${recordDir}: ${r.reason}`);
  await writeAtomic(join(recordDir, "record.json"), JSON.stringify(r.record, null, 2));
  progress.recordDir = recordDir;
  progress.runId = String(record.runId);
  progress.verdict = r.verdict.verdict;
  process.stdout.write(`${String(record.runId)} ${r.verdict.verdict}\n${r.verdict.reasons.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exitCode = r.verdict.verdict === "PASS" ? 0 : r.verdict.verdict === "FAIL" ? 1 : 3;
}

/** A finished run's stored evidence and its fixture, as the regrade reads them. Throws when the record names no known fixture. */
export function regradeInputFrom(recordDir: string, rawDir: string, fixtures = FIXTURES): RegradeInput {
  const recordBytes = readFileSync(join(recordDir, "record.json"));
  const record = JSON.parse(recordBytes.toString("utf-8")) as { client?: unknown; fixture?: unknown; variant?: unknown; checkSetVersion?: unknown };
  // The record's own check set decides the rubric projection and the owner script; the regrade refuses one it does not know.
  const checkSet = record.checkSetVersion === undefined ? 1 : Number(record.checkSetVersion);
  const fixture = String(record.fixture);
  if (!/^[a-z0-9-]+$/.test(fixture) || !existsSync(join(fixtures, fixture, "rubric.json"))) throw new Error(`the record names no known fixture (${fixture})`);
  if (record.client !== "claude" && record.client !== "codex") throw new Error(`the record names no known client (${String(record.client)})`);
  const fixtureDir = join(fixtures, fixture);
  const files: ManifestEntry[] = [];
  const pinned = (rel: string): string => { const b = readFileSync(join(fixtureDir, rel)); files.push({ path: `fixture/${rel}`, sha256: sha256(b) }); return b.toString("utf-8"); };
  const rubric = rubricFor(JSON.parse(pinned("rubric.json")) as Record<string, unknown>, checkSet) as unknown as FixtureRubric;
  const script = ownerScript(pinned(ownerScriptFile(fixtureDir, checkSet)));
  const firstPrompt = firstPromptFor(record.client, pinned("opening-prompt.txt"));
  const beforePath = join("project", ".story", "config.json");
  const beforeText = existsSync(join(fixtureDir, beforePath)) ? pinned(beforePath) : null;
  const story = join(rawDir, "project.after", ".story");
  const storeCopy = join(rawDir, STORE_COPY);
  const evidence = fixtureEvidence(join(fixtureDir, "project"));
  const afterPackage = packageTurns(baseVariant(record.variant as Variant | SessionVariant), script);
  // T-538 S5a: a session variant's later turns read the same owner script.
  const sessions = isSessionVariant(String(record.variant)) ? { sessionScript: sessionScript(readFileSync(join(fixtureDir, ownerScriptFile(fixtureDir, checkSet)), "utf-8")) } : {};
  // Check set 7 also reads the fixture's own ledger; pinned only from 7 on, so older records keep their manifests.
  const set7 = checkSet >= 7 ? { baseline: fixtureBaseline(fixtureDir, pinned), approval: afterPackage.find((x) => x.label === "approve")?.prompt ?? "" } : {};
  return {
    recordBytes,
    packetBytes: readFileSync(join(recordDir, "grading-packet.json")),
    rawNames: readdirSync(rawDir),
    readRaw: (name) => readFileSync(join(rawDir, name)),
    stateNames: stateNames(rawDir),
    story: existsSync(story) ? diskStoryBytes(story) : null,
    setupReviewStore: existsSync(storeCopy) ? storeCopy : null,
    fixture: {
      firstPrompt, discoveryPrompt: script.discovery, afterPackage, rubric,
      beforeConfig: () => { if (beforeText === null) throw new Error("the fixture has no .story/config.json"); return JSON.parse(beforeText) as Record<string, unknown>; },
      briefs: evidence.briefs, projectFiles: evidence.projectFiles,
      files: [...files, ...evidence.hashes.map((h) => ({ path: `fixture/${h.path}`, sha256: h.sha256 }))],
      checkSet,
      ...set7,
      ...sessions,
    },
    reviewLine: REVIEW_LINE,
    semanticLines: runSemanticLines,
  };
}

/**
 * T-538 6.2: a milestone-states record's state records, recomputed from their copies with the product's loader
 * (asynchronous, so before the synchronous regrade). The regrade checks the copies' pins and compares. A records
 * file that cannot be read is left to the regrade, which refuses it by name.
 */
export async function withRecomputedStates(input: RegradeInput, rawDir: string): Promise<RegradeInput> {
  const record = JSON.parse(input.recordBytes.toString("utf-8")) as Record<string, unknown>;
  if (record.variant !== "milestone-states" || !input.rawNames.includes(STATES_RAW)) return input;
  let recorded: StateRecord[];
  try { recorded = parseStateRecords(input.readRaw(STATES_RAW).toString("utf-8")); } catch { return input; }
  return { ...input, recomputedStates: await recomputeStates(rawDir, recorded, (input.fixture.rubric as { followUp?: { checkpoint: Parameters<typeof recomputeStates>[2] } }).followUp?.checkpoint ?? null) };
}

/**
 * `--regrade <recordDir> --raw <rawDir> [--judge <judge.json>]`: re-derives a finished run from its raw
 * transcripts and writes the next revision under `<recordDir>/regrade/`, never the original record. Exit 2
 * on a refusal, 1 on FAIL, 3 while the judge is still owed, 0 on PASS.
 */
export async function regradeCli(argv: readonly string[]): Promise<void> {
  progress.stage = "regrade";
  const at = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const recordDir = at("regrade"); const rawDir = at("raw"); const judgePath = at("judge");
  if (!recordDir || !rawDir) throw new Error("--regrade <recordDir> --raw <rawDir> [--judge <judge.json>]");
  const judge = judgePath ? JSON.parse(readFileSync(judgePath, "utf-8")) as RegradeJudge : null;
  const r = runRegrade(recordDir, await withRecomputedStates(regradeInputFrom(recordDir, rawDir), rawDir), judge, () => new Date().toISOString());
  if (!r.ok) {
    process.stderr.write(`onboarding-eval: regrade refused for ${recordDir}: ${r.reason}\n`);
    process.exitCode = 2;
    progress.refusal = `regrade refused for ${recordDir}: ${r.reason}`;
    return;
  }
  const v = r.run.revision;
  progress.recordDir = recordDir;
  progress.verdict = v.verdict;
  process.stdout.write(`${r.run.written} revision ${v.revision} ${v.status} ${v.verdict}\n  guarantee: ${v.guarantee}\n  limitation: ${v.limitation}\n${v.reasons.map((f) => `  - ${f}`).join("\n")}\n${v.candidates.map((c) => `  ? ${JSON.stringify(c)}`).join("\n")}\n`);
  process.exitCode = v.verdict === "PASS" ? 0 : v.verdict === "FAIL" ? 1 : 3;
}

/**
 * The runner's whole entry. The CLI below never passes `admission`, so a Claude run from the command line is
 * always refused; only test/fixtures/t538-admitted-runner.ts passes a stand-in admission (T-538 S0, pen ruling G1).
 */
export function runnerCli(argv: readonly string[], admission?: StandInAdmission): void {
  // T-538 commit 4 (7.3): every terminal path, a thrown error included, ends in the `--result` file when one is asked for.
  const mode = argv.includes("--regrade") ? "regrade" : argv.includes("--finalize") ? "finalize" : "run";
  let resultPath: string | null = null;
  try { resultPath = resultPathOf(argv); } catch (err) { process.stderr.write(`${(err as Error).message}\n`); process.exitCode = 2; }
  if (process.exitCode !== 2) {
    void withRunnerResult(resultPath, mode, progress, () => (mode === "regrade" ? regradeCli(argv) : mode === "finalize" ? finalize(argv) : main(argv, admission)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runnerCli(process.argv.slice(2));
