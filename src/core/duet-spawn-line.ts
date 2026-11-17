/**
 * T-575 (handover lines slice B2): `duet spawn` opens the worker's own
 * handover line before the worker starts (plan sections 4 to 7).
 *
 * Two files carry the opening's state, one writer each. The plan lives in the
 * spawn journal's entry, written once by the handler. The progress lives in
 * an opening record beside the journal (`<spawnDir>/<name>.opening`, no
 * `.json` suffix), written only by `openWorkerLine` and only while it holds
 * the WORKER board's project lock. The journal is never written here.
 *
 * The record is history. Every call derives its result from the worker's
 * memo as it is now; the record only decides what must not be repeated.
 */
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { normalizeClientTaskId } from "../autonomous/client-profile.js";
import { continueLineUnlocked, createHandoverUnlocked } from "../cli/commands/handover.js";
import { validateWorkerName } from "./duet-spawn.js";
import { handoverFilenameDate } from "./handover-filename.js";
import {
  isMemoFile,
  lineMemoDisplayPath,
  resolveLineMemo,
  resolveLineMemoStrict,
  verifyHandoverDigest,
  writeLineMemo,
  type LineMemo,
  type MemoWriting,
  type StrictMemoResolution,
} from "./handover-line-memo.js";
import { buildLineageGraph } from "./handover-lineage.js";
import { scanHandoverLineage } from "./handover-lineage-scan.js";
import { listHandovers } from "./handover-parser.js";
import { TailReader } from "./handover-selection.js";
import { withProjectLock } from "./project-loader.js";
import { readBoundedNoFollow } from "../presence/io.js";
import type { LoadWarning } from "./errors.js";

export const OPENING_RECORD_MAX_BYTES = 65_536;
const DIGEST = /^[0-9a-f]{64}$/;

export type OpeningMode = "new-line" | "continue" | "none";
export const OPENING_MODES: readonly OpeningMode[] = ["new-line", "continue", "none"];

/** The plan, in the journal's `base` entry: written once, never changed. */
export interface OpeningPlan {
  readonly mode: OpeningMode;
  /** `realpath(workerProjectRoot ?? penRoot)`: the canonical worker board. */
  readonly board: string;
  /** Non-null exactly when `mode` is `continue`. */
  readonly continueFile: string | null;
}

export type OpeningOutcome = "opened" | "repaired" | "continued" | "already-on-line" | "default-line";
const OUTCOMES: readonly OpeningOutcome[] = ["opened", "repaired", "continued", "already-on-line", "default-line"];

/** The progress, in the opening record. */
export interface OpeningRecord {
  readonly v: 1;
  readonly task: string;
  readonly intent: MemoWriting | null;
  readonly attempt: { readonly file: string; readonly defaultLine: boolean } | null;
  readonly outcome: OpeningOutcome | null;
  readonly file: string | null;
}

export interface OpeningResult {
  readonly outcome: OpeningOutcome;
  /** The line's file: the opening, the continued target, or the worker's current tip. Null for `default-line`. */
  readonly file: string | null;
  /** The opening's `from`, when this call wrote it. */
  readonly from: string | null;
  readonly note: string | null;
}

export type OpeningStopReason = "lock" | "record" | "memo" | "file" | "write" | "continue";

/** Any stop of the opening stage. Spawn does not launch. */
export class OpeningStopped extends Error {
  constructor(
    readonly reason: OpeningStopReason,
    readonly diagnostic: string,
    readonly board: string,
    readonly workerTaskId: string,
  ) {
    super(`the worker's handover line could not be established on ${board} for worker ${workerTaskId}: ${diagnostic}`);
    this.name = "OpeningStopped";
  }
}

/** Thrown by the `beforeWrite` hook when the intent could not be written to the record. */
export class OpeningIntentNotPersisted extends Error {
  constructor(readonly cause: unknown) {
    super("the opening intent could not be recorded");
    this.name = "OpeningIntentNotPersisted";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function isTaskId(v: unknown): v is string {
  return typeof v === "string" && normalizeClientTaskId(v) === v;
}

/** The fields of a journal entry the opening uses, after `decodeOpeningPlan` accepted them. */
export interface DecodedOpening {
  readonly name: string;
  readonly workerDir: string;
  readonly workerTaskId: string;
  readonly plan: OpeningPlan;
}

/**
 * Pure apart from two `stat`s; never throws. Null for anything but a journal
 * entry whose every field the opening uses is valid (plan section 4).
 */
export function decodeOpeningPlan(entry: unknown): DecodedOpening | null {
  try {
    if (!isObject(entry)) return null;
    const { name, workerDir, workerTaskId, opening } = entry;
    if (typeof name !== "string") return null;
    try { validateWorkerName(name); } catch { return null; }
    if (typeof workerDir !== "string" || !isAbsolute(workerDir)) return null;
    try {
      // statSync follows a symlink, exactly as resolveWorkerDir accepts a --dir given through one.
      if (!statSync(workerDir).isDirectory()) return null;
    } catch {
      return null;
    }
    if (!isTaskId(workerTaskId)) return null;
    if (!isObject(opening) || !hasExactKeys(opening, ["mode", "board", "continueFile"])) return null;
    const { mode, board, continueFile } = opening;
    if (typeof mode !== "string" || !(OPENING_MODES as readonly string[]).includes(mode)) return null;
    if (typeof board !== "string" || !isAbsolute(board)) return null;
    let real: string;
    try { real = realpathSync(board); } catch { return null; }
    if (real !== board) return null;
    try {
      const story = lstatSync(join(board, ".story"));
      if (story.isSymbolicLink() || !story.isDirectory()) return null;
    } catch {
      return null;
    }
    if (continueFile !== null && !isMemoFile(continueFile)) return null;
    if ((continueFile !== null) !== (mode === "continue")) return null;
    return { name, workerDir, workerTaskId, plan: { mode: mode as OpeningMode, board, continueFile: continueFile as string | null } };
  } catch {
    return null;
  }
}

/** Pure; never throws. Null for anything but exactly the record shape for `workerTaskId`. */
export function decodeOpeningRecord(text: string, workerTaskId: string): OpeningRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObject(raw) || !hasExactKeys(raw, ["v", "task", "intent", "attempt", "outcome", "file"])) return null;
  if (raw.v !== 1 || raw.task !== workerTaskId) return null;
  let intent: MemoWriting | null = null;
  if (raw.intent !== null) {
    const i = raw.intent;
    if (!isObject(i) || !hasExactKeys(i, ["file", "sha256"])) return null;
    if (!isMemoFile(i.file) || typeof i.sha256 !== "string" || !DIGEST.test(i.sha256)) return null;
    intent = { file: i.file, sha256: i.sha256 };
  }
  let attempt: OpeningRecord["attempt"] = null;
  if (raw.attempt !== null) {
    const a = raw.attempt;
    if (!isObject(a) || !hasExactKeys(a, ["file", "defaultLine"])) return null;
    if (!isMemoFile(a.file) || typeof a.defaultLine !== "boolean") return null;
    attempt = { file: a.file, defaultLine: a.defaultLine };
  }
  if (raw.outcome !== null && !(typeof raw.outcome === "string" && (OUTCOMES as readonly string[]).includes(raw.outcome))) return null;
  if (raw.file !== null && !isMemoFile(raw.file)) return null;
  return { v: 1, task: workerTaskId, intent, attempt, outcome: raw.outcome as OpeningOutcome | null, file: raw.file as string | null };
}

export function emptyOpeningRecord(task: string): OpeningRecord {
  return { v: 1, task, intent: null, attempt: null, outcome: null, file: null };
}

export type OpeningRecordRead = { readonly kind: "ok"; readonly record: OpeningRecord } | { readonly kind: "unreadable" };

/** An absent record is the empty record; one that exists and cannot be read or decoded is unreadable. */
export function readOpeningRecord(path: string, task: string): OpeningRecordRead {
  try {
    lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "ok", record: emptyOpeningRecord(task) } : { kind: "unreadable" };
  }
  const text = readBoundedNoFollow(path, OPENING_RECORD_MAX_BYTES);
  if (text === null) return { kind: "unreadable" };
  const record = decodeOpeningRecord(text, task);
  return record === null ? { kind: "unreadable" } : { kind: "ok", record };
}

export function serializeOpeningRecord(r: OpeningRecord): string {
  return JSON.stringify({ v: 1, task: r.task, intent: r.intent, attempt: r.attempt, outcome: r.outcome, file: r.file }, null, 2) + "\n";
}

/** Temp file, fsync, rename. Throws on any failure. */
export function writeOpeningRecordAtomic(path: string, record: OpeningRecord): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, serializeOpeningRecord(record), "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

export interface ComposeOpeningInput {
  readonly name: string;
  readonly pen: string;
  readonly penTaskId: string | null;
  readonly workerTaskId: string;
  readonly arrangementId: string | null;
  readonly bounds: readonly string[];
  readonly now: Date;
  /** The pen's canonical board, given only when it differs from the worker's. */
  readonly penBoard: string | null;
}

/** Plan section 6: the opening's fixed text. The lineage trailer is the create core's. */
export function composeOpeningHandover(input: ComposeOpeningInput): string {
  const origin = input.penBoard !== null ? `, from the board at ${input.penBoard}` : "";
  const refs = input.bounds.length > 0 ? input.bounds.map((r) => `- ${r}`) : ["- (none given)"];
  return [
    `# Worker line opened: ${input.name}`,
    "",
    `- Dispatched by: ${input.pen} (task ${input.penTaskId ?? "not recorded"})${origin}`,
    `- Worker: ${input.name} (task ${input.workerTaskId})`,
    `- Date: ${handoverFilenameDate(input.now, false)}`,
    `- Arrangement: ${input.arrangementId ?? "none"}`,
    "",
    "## Assignment",
    "",
    ...refs,
    "",
  ].join("\n");
}

export interface OpeningInput {
  readonly penRoot: string;
  readonly journalPath: string;
  readonly recordPath: string;
  readonly plan: OpeningPlan;
  readonly name: string;
  readonly pen: string;
  readonly penTaskId: string | null;
  readonly workerTaskId: string;
  readonly arrangementId: string | null;
  readonly bounds: readonly string[];
  readonly now: () => Date;
}

/** Injected seams. Production passes none. */
export interface OpeningDeps {
  readonly lock?: (board: string, fn: () => Promise<void>) => Promise<void>;
  readonly writeRecord?: (path: string, record: OpeningRecord) => void;
  readonly continueLine?: typeof continueLineUnlocked;
  /** Test seams: a throw simulates a crash at that point. */
  readonly seams?: {
    readonly beforeLock?: () => Promise<void> | void;
    readonly beforeIntentRecord?: () => void;
    readonly afterIntentRecord?: () => void;
    readonly beforeOutcome?: () => void;
  };
}

const defaultLock = (board: string, fn: () => Promise<void>): Promise<void> => withProjectLock(board, { strict: false }, fn);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface BoardView {
  readonly handoversDir: string;
  readonly tails: TailReader;
  readonly head: string | null;
}

async function viewBoard(board: string): Promise<BoardView | null> {
  const handoversDir = join(board, ".story", "handovers");
  const warnings: LoadWarning[] = [];
  const names = await listHandovers(handoversDir, board, warnings);
  if (warnings.some((w) => w.type === "parse_error")) return null;
  const graph = buildLineageGraph(scanHandoverLineage(handoversDir, names, true));
  return { handoversDir, tails: new TailReader(handoversDir, names), head: graph.head };
}

/**
 * Plan section 5: opens, adopts or confirms the worker's line, under the
 * worker board's lock. Returns the verified result or throws
 * `OpeningStopped`. Never writes the journal; never writes on the pen's
 * board except the record beside the journal.
 */
export async function openWorkerLine(input: OpeningInput, deps: OpeningDeps = {}): Promise<OpeningResult> {
  const { plan, workerTaskId } = input;
  const board = plan.board;
  const stop = (reason: OpeningStopReason, diagnostic: string): OpeningStopped => new OpeningStopped(reason, diagnostic, board, workerTaskId);
  if (plan.mode === "none") throw new Error("openWorkerLine: mode none runs no stage");
  await deps.seams?.beforeLock?.();
  let entered = false;
  let result: OpeningResult | null = null;
  try {
    await (deps.lock ?? defaultLock)(board, async () => {
      entered = true;
      result = await openLocked(input, deps, stop);
    });
  } catch (err) {
    if (err instanceof OpeningStopped) throw err;
    if (!entered) throw stop("lock", message(err));
    throw stop("write", message(err));
  }
  if (result === null) throw stop("write", "the opening stage produced no result");
  return result;
}

async function openLocked(input: OpeningInput, deps: OpeningDeps, stop: (r: OpeningStopReason, d: string) => OpeningStopped): Promise<OpeningResult> {
  const { plan, workerTaskId: task, recordPath } = input;
  const board = plan.board;
  const writeRecord = deps.writeRecord ?? writeOpeningRecordAtomic;
  const memoPath = join(board, lineMemoDisplayPath(task));
  const wayOut = `run \`storybloq handover continue <file> --as ${task}\` (or \`--default\`) on that board, then \`storybloq duet spawn --recover --open-line ${task}\``;

  // Step 2: the record, read and decoded under the lock.
  const read = readOpeningRecord(recordPath, task);
  if (read.kind === "unreadable") throw stop("record", `the opening record ${recordPath} cannot be read`);
  let R = read.record;
  /** Read, merge, atomic write; throws when the record cannot be written. */
  const put = (patch: Partial<Omit<OpeningRecord, "v" | "task">>): void => {
    const now = readOpeningRecord(recordPath, task);
    if (now.kind === "unreadable") throw new Error(`the opening record ${recordPath} cannot be read`);
    const next: OpeningRecord = { ...now.record, ...patch };
    writeRecord(recordPath, next);
    R = next;
  };
  /** A history write whose failure does not stop the launch (plan D7). */
  const putQuietly = (patch: Partial<Omit<OpeningRecord, "v" | "task">>): void => {
    try { put(patch); } catch { /* the memo is the verified fact; a replay repairs the record */ }
  };

  // Step 3: the worker's line now.
  const resolveNow = async (): Promise<{ view: BoardView; s: StrictMemoResolution }> => {
    const view = await viewBoard(board);
    if (view === null) throw stop("memo", `the handovers folder on ${board} could not be listed`);
    return { view, s: resolveLineMemoStrict(board, task, view.tails) };
  };
  const refuseUnsettled = (s: StrictMemoResolution): void => {
    if (s.kind === "unknown") throw stop("memo", `${memoPath}: ${s.why}; ${wayOut}`);
    if (s.kind === "stale") throw stop("memo", `${memoPath}: its tip ${s.tip} is ${s.reason}; ${wayOut}`);
  };
  let { view, s: S } = await resolveNow();
  refuseUnsettled(S);

  if (plan.mode === "continue") {
    const F = plan.continueFile as string;
    // Step 4.
    if (S.kind === "active") {
      const outcome: OpeningOutcome = S.tip === F ? "continued" : "already-on-line";
      putQuietly({ outcome, file: S.tip });
      return { outcome, file: S.tip, from: null, note: null };
    }
    // Step 5: no memo.
    if (R.attempt !== null && R.attempt.file === F && R.attempt.defaultLine) {
      putQuietly({ outcome: "continued", file: F });
      return { outcome: "continued", file: F, from: null, note: "the default line" };
    }
    const defaultLine = view.head === F;
    try {
      put({ attempt: { file: F, defaultLine }, outcome: null });
    } catch (err) {
      throw stop("record", `the opening record ${recordPath} could not be written: ${message(err)}`);
    }
    const out = await (deps.continueLine ?? continueLineUnlocked)(board, task, F);
    if (!out.ok) {
      const r = out.refusal;
      const extra = r.code === "not_a_tip" ? ` (descendant tips: ${r.tips.join(", ") || "none open"})` : r.code === "scan_incomplete" ? ` (unread: ${r.unread.join(", ")})` : "";
      throw stop("continue", `${r.code}: ${r.message}${extra}`);
    }
    ({ view, s: S } = await resolveNow());
    if (defaultLine ? S.kind !== "none" : !(S.kind === "active" && S.tip === F)) {
      throw stop("memo", `${memoPath} does not show the adopted line ${F} after adoption`);
    }
    deps.seams?.beforeOutcome?.();
    putQuietly({ outcome: "continued", file: F });
    return { outcome: "continued", file: F, from: null, note: defaultLine ? "the default line" : null };
  }

  // Mode new-line. Step 6: the committed check.
  let committed: MemoWriting | null = null;
  if (R.intent !== null) {
    const v = verifyHandoverDigest(view.handoversDir, R.intent.file, R.intent.sha256);
    if (v === "unknown") throw stop("file", `the opening file ${join(view.handoversDir, R.intent.file)} cannot be verified`);
    if (v === "match") committed = R.intent;
  }
  let wroteNow = false;
  let from: string | null = null;
  if (committed === null) {
    // Step 7.
    if (S.kind === "active") {
      putQuietly({ outcome: "already-on-line", file: S.tip });
      return { outcome: "already-on-line", file: S.tip, from: null, note: null };
    }
    if (R.outcome === "default-line") {
      return { outcome: "default-line", file: null, from: null, note: "the opening intent could not be recorded" };
    }
    if (R.outcome === "already-on-line" || R.outcome === "opened" || R.outcome === "repaired") {
      throw stop("memo", `${memoPath} is gone and the recorded line ${R.file ?? "(none)"} has no committed opening; ${wayOut}`);
    }
    // Step 8: write the opening.
    from = openingFrom(input, view);
    const penBoard = sameBoard(input) ? null : canonical(input.penRoot);
    const content = composeOpeningHandover({ name: input.name, pen: input.pen, penTaskId: input.penTaskId, workerTaskId: task, arrangementId: input.arrangementId, bounds: input.bounds, now: input.now(), penBoard });
    let planned: MemoWriting | null = null;
    let intentPersisted = false;
    try {
      const created = await createHandoverUnlocked(board, {
        content,
        slug: `${input.name}-line-opened`,
        lineage: { newLine: true, role: "worker", ...(from !== null ? { from } : {}), as: task },
      }, {
        beforeWrite: (p) => {
          deps.seams?.beforeIntentRecord?.();
          try {
            put({ intent: { file: p.file, sha256: p.sha256 }, outcome: null });
          } catch (err) {
            throw new OpeningIntentNotPersisted(err);
          }
          intentPersisted = true;
          planned = { file: p.file, sha256: p.sha256 };
          deps.seams?.afterIntentRecord?.();
        },
      });
      const last = planned as MemoWriting | null;
      if (last === null || last.file !== created.filename) throw new Error(`the created file ${created.filename} is not the recorded intent`);
      committed = last;
      wroteNow = true;
    } catch (err) {
      if (err instanceof OpeningIntentNotPersisted) {
        try { put({ outcome: "default-line" }); } catch { /* no opening exists, which is established */ }
        return { outcome: "default-line", file: null, from: null, note: "the opening intent could not be recorded" };
      }
      throw stop("write", `${intentPersisted ? "after the opening intent was recorded: " : ""}${message(err)}`);
    }
  }

  // Step 9: verify before reporting.
  const file = committed.file;
  if (verifyHandoverDigest(view.handoversDir, file, committed.sha256) !== "match") {
    throw stop("file", `the opening file ${join(view.handoversDir, file)} does not hold the recorded bytes`);
  }
  ({ view, s: S } = await resolveNow());
  if (S.kind === "none") {
    const memo: LineMemo = { v: 1, task, tip: file, writing: null };
    if (!writeLineMemo(board, memo)) throw stop("memo", `${memoPath} could not be written`);
    ({ view, s: S } = await resolveNow());
  }
  if (S.kind !== "active") {
    throw stop("memo", `${memoPath} does not resolve to a line after the opening ${file} (${S.kind})`);
  }
  deps.seams?.beforeOutcome?.();
  const outcome: OpeningOutcome = wroteNow ? "opened" : "repaired";
  putQuietly({ outcome, file });
  return { outcome, file, from: wroteNow ? from : null, note: null };
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function sameBoard(input: OpeningInput): boolean {
  return input.plan.board === canonical(input.penRoot);
}

/**
 * Plan section 5, `from`: only on the pen's own board. The manager's current
 * tip when its memo is active, else the default head, else none. The
 * manager's memo is only read.
 */
function openingFrom(input: OpeningInput, view: BoardView): string | null {
  if (!sameBoard(input)) return null;
  if (input.penTaskId !== null) {
    const m = resolveLineMemo(input.plan.board, input.penTaskId, view.tails);
    if (m.kind === "active") return m.tip;
  }
  return view.head;
}
