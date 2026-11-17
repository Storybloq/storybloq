import { ledgerOptions, ledgerState, ledgerStates, withLedgerState } from "../../core/ledger-state.js";
import { extractHandoverDate, listHandovers, readHandover } from "../../core/handover-parser.js";
import { buildHandoverBrief, isFilenameAdmitted, CROSS_HANDOVER_BUDGET } from "../../core/handover-brief.js";
import { buildBriefOtherLines, buildRawOtherLines } from "../../core/handover-other-lines.js";
import {
  HANDOVER_TEMPLATE_MARKER,
  computeCarriedForward,
  hasCarriedForwardHeading,
  parseCarriedForwardSection,
  parseOverrideBody,
  renderHandoverTemplate,
  type CarriedForwardEntry,
  type OverrideLine,
} from "../../core/handover-template.js";
import { parseHandoverMarkdown, type TrajectoryEntry } from "../../core/markdown-sections.js";
import {
  appendLineage,
  buildLineageGraph,
  buildLinesView,
  isLineageAtValue,
  isLineageByValue,
  isLineageFileValue,
  isLineageRoleValue,
  serializeLineage,
  readLineage,
  splitLineage,
  walkLine,
  type AbsorbDropReason,
  type ContinuesState,
  type CreateLineageResult,
  type LineageWarning,
  type LineageWarningCode,
} from "../../core/handover-lineage.js";
import { scanHandoverLineage } from "../../core/handover-lineage-scan.js";
import {
  PICKUP_PROMPT,
  isMemoFile,
  lineMemoDisplayPath,
  removeLineMemo,
  writeLineMemo,
  resolveLineMemo,
  type ContinueResult,
  type MemoResolution,
} from "../../core/handover-line-memo.js";
import {
  TailReader,
  readHandoverBody,
  selectHandovers,
  selectionNotices,
  scanRecentTails,
  finaliseRecentLines,
  recentCutoff,
  type HandoverLinesAddition,
  type HandoverSelection,
  type OtherLines,
  type RecentLines,
  type RecentScan,
} from "../../core/handover-selection.js";
import { handoverFilenameDate } from "../../core/handover-filename.js";
import { currentClientTaskId, normalizeClientTaskId } from "../../autonomous/client-profile.js";
import { extractHandoverHeading } from "../../federation/handover-utils.js";
import type { LoadWarning } from "../../core/errors.js";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { recordBoardTarget } from "../../core/board-write-recorder.js";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  formatHandoverList,
  formatHandoverContent,
  formatHandoverEmptyDefault,
  formatHandoverLinesMd,
  formatHandoverBrief,
  formatHandoverTemplate,
  formatHandoverCreateResult,
  formatHandoverLines,
  formatHandoverContinue,
  formatError,
  ExitCode,
  type HandoverStampFailure,
} from "../../core/output-formatter.js";
import {
  withProjectLock,
  atomicWrite,
  fencedLink,
  guardPath,
  detectTeamModeFromDisk,
} from "../../core/project-loader.js";
import { parseHandoverFilename, CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

export function handleHandoverList(ctx: CommandContext): CommandResult {
  return { output: formatHandoverList(ctx.state.handoverFilenames, ctx.format) };
}

/**
 * ISS-1499 slice A: `handover lines` (plan section 6). Read-only: lists the
 * folder itself (so a listing failure is known), one tail read per
 * handover through the scan, no cache, no writes. The exit code comes from
 * the same listing as the view: PARTIAL when this listing failed, whatever
 * the loader's own earlier listing did. An incomplete scan of a full
 * listing stays OK; the view says complete false.
 */
export async function handleHandoverLines(ctx: CommandContext, opts: { readonly all?: boolean } = {}): Promise<CommandResult> {
  const listWarnings: LoadWarning[] = [];
  const names = await listHandovers(ctx.handoversDir, ctx.root, listWarnings);
  const enumerated = !listWarnings.some((w) => w.type === "parse_error");
  const scan = scanHandoverLineage(ctx.handoversDir, enumerated ? names : [], enumerated);
  const view = buildLinesView(scan, opts.all === true, extractHandoverDate);
  return {
    output: formatHandoverLines(view, extractHandoverDate, ctx.format),
    exitCode: enumerated ? ExitCode.OK : ExitCode.PARTIAL,
  };
}

export interface HandoverContinueOptions {
  readonly file?: string;
  readonly toDefault?: boolean;
  readonly fork?: boolean;
  /** `--as`: the identity to continue for, instead of the environment's. */
  readonly as?: string;
}

/** Up to ten names and the full count, for a refusal message. */
function listSome(names: readonly string[]): string {
  const shown = names.slice(0, 10).join(", ");
  return names.length > 10 ? `${shown} and ${names.length - 10} more` : shown;
}

interface GitRun { readonly code: number | null; readonly stdout: string }

/** `code` is the exit status, or null when git did not run to completion (a timeout, a spawn failure). */
function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((done) => {
    execFile("git", [...args], { cwd, timeout: 3000 }, (err, stdout) => {
      if (!err) return done({ code: 0, stdout: stdout.trim() });
      const code = (err as { code?: unknown }).code;
      const killed = (err as { killed?: boolean }).killed === true;
      done({ code: !killed && typeof code === "number" ? code : null, stdout: "" });
    });
  });
}

/** A full object id for this repository's hash: 40 hex for sha1. Slice A caps `at` at 40, so a sha256 repository never has one. */
const FULL_ID_LENGTH: Record<string, number> = { sha1: 40, sha256: 64 };

/**
 * Rule 10: the tip's `at` against HEAD. `not_in_clone` only when `at` is a
 * full object id for this repository, `rev-parse --verify --quiet` exits 1
 * and `cat-file -t` also fails: the object truly is not here. An
 * abbreviation (perhaps ambiguous), a full id naming another kind of object,
 * and any other failure of a check or of the count are `unavailable`, never
 * a claim that the commit is absent. The count uses the full commit id
 * rev-parse printed, never the raw `at`.
 */
async function atAgainstHead(root: string, at: string | null): Promise<Pick<Extract<ContinueResult, { action: "continue" }>, "atState" | "commitsSince">> {
  if (at === null) return { atState: "none", commitsSince: null };
  const tree = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (tree.code !== 0 || tree.stdout !== "true") return { atState: "none", commitsSince: null };
  const unavailable = { atState: "unavailable", commitsSince: null } as const;
  const present = await runGit(root, ["rev-parse", "--verify", "--quiet", `${at}^{commit}`]);
  if (present.code === 1) {
    const format = await runGit(root, ["rev-parse", "--show-object-format"]);
    if (format.code !== 0 || at.length !== FULL_ID_LENGTH[format.stdout]) return unavailable;
    const kind = await runGit(root, ["cat-file", "-t", at]);
    return kind.code !== null && kind.code !== 0 ? { atState: "not_in_clone", commitsSince: null } : unavailable;
  }
  if (present.code !== 0) return unavailable;
  const count = await runGit(root, ["rev-list", "--count", `${present.stdout}..HEAD`]);
  const n = count.code === 0 ? Number(count.stdout) : NaN;
  return Number.isInteger(n) ? { atState: "counted", commitsSince: n } : { atState: "unavailable", commitsSince: null };
}

/**
 * ISS-1499 slice B: `handover continue <file> | --default` (plan section 5).
 * Puts this session on a line by writing its memo, or back on the default
 * line by removing it. The rules run in the plan's order; a refusal writes
 * nothing. The only lineage command that refuses for want of an identity.
 */
export async function handleHandoverContinue(ctx: CommandContext, opts: HandoverContinueOptions): Promise<CommandResult> {
  const hasFile = typeof opts.file === "string";
  if (hasFile === (opts.toDefault === true)) {
    throw new CliValidationError("invalid_input", "Name exactly one of a handover file or --default.");
  }
  if (opts.as !== undefined && normalizeClientTaskId(opts.as) === null) {
    throw new CliValidationError("invalid_input", "--as is not a valid client task id.");
  }
  const taskId = currentClientTaskId(opts.as);
  if (taskId === null) {
    throw new CliValidationError("no_identity", "No session identity resolved; pass --as <clientTaskId>.");
  }
  const root = resolve(ctx.root);
  const memoPath = lineMemoDisplayPath(taskId);
  let result: ContinueResult | null = null;
  let at: string | null = null;

  await withProjectLock(root, { strict: false }, async () => {
    const listWarnings: LoadWarning[] = [];
    const names = await listHandovers(ctx.handoversDir, root, listWarnings);
    const enumerated = !listWarnings.some((w) => w.type === "parse_error");
    const scan = scanHandoverLineage(ctx.handoversDir, enumerated ? names : [], enumerated);
    const graph = buildLineageGraph(scan);

    const toDefault = (): void => {
      const outcome = removeLineMemo(root, taskId);
      if (outcome === "failed") {
        throw new CliValidationError("io_error", `Could not remove the line memo ${memoPath}; this session is still on its previous line.`);
      }
      result = { action: "default", memo: outcome, head: graph.head };
    };
    if (!hasFile) return toDefault();

    const file = opts.file as string;
    if (!isMemoFile(file)) throw new CliValidationError("invalid_input", "Not a handover file name.");
    const entry = scan.files.find((f) => f.name === file);
    if (entry === undefined) {
      throw new CliValidationError("not_found", `Handover not found: ${file}${enumerated ? "" : " (the handovers folder could not be listed)"}`);
    }
    if (entry.state === "unknown") throw new CliValidationError("invalid_input", `Not a regular readable handover: ${file}`);
    if (file === graph.head) return toDefault();

    if (!scan.complete && opts.fork !== true) {
      const unread = scan.files.filter((f) => f.state === "unknown").map((f) => f.name);
      throw new CliValidationError("scan_incomplete", `${unread.length} handover(s) could not be read, so ${file} cannot be confirmed as a tip: ${listSome(unread)}. Pass --fork to continue it anyway.`);
    }
    if ((graph.children.get(file) ?? []).length > 0 && opts.fork !== true) {
      const open = new Set(graph.openTips);
      const tips: string[] = [];
      const visited = new Set<string>([file]);
      const queue = [...(graph.children.get(file) ?? [])];
      for (let i = 0; i < queue.length && i <= scan.files.length; i++) {
        const n = queue[i]!;
        if (visited.has(n)) continue;
        visited.add(n);
        if (open.has(n)) tips.push(n);
        queue.push(...(graph.children.get(n) ?? []));
      }
      const listed = tips.length > 0 ? `; its open tips: ${listSome(tips)}` : "";
      throw new CliValidationError("not_a_tip", `${file} is not a tip: it has a newer handover on its line${listed}. Continue a tip, or pass --fork to branch from it.`);
    }

    if (!writeLineMemo(root, { v: 1, task: taskId, tip: file, writing: null })) {
      throw new CliValidationError("io_error", `Could not write the line memo ${memoPath}.`);
    }
    const lineage = entry.state === "linked" ? entry.lineage?.lineage ?? null : null;
    at = lineage?.at ?? null;
    result = {
      action: "continue",
      tip: file,
      role: lineage?.role ?? null,
      by: lineage?.by ?? null,
      length: walkLine(graph, file).files.length,
      absorbedBy: [...(graph.absorbedBy.get(file) ?? [])],
      at,
      atState: "none",
      commitsSince: null,
      pickup: PICKUP_PROMPT,
    };
  });

  let final = result as ContinueResult | null;
  if (final === null) throw new Error("handover continue produced no result");
  if (final.action === "continue") final = { ...final, ...(await atAgainstHead(root, at)) };
  return { output: formatHandoverContinue(final, ctx.format) };
}

export interface HandoverLatestOptions {
  readonly brief?: boolean;
  readonly priming?: boolean;
  /** C-v4.1 commit 7: the ledger-state line per handover, full mode only. Set by the CLI and MCP gets, not the guide. */
  readonly ledger?: boolean;
  /** ISS-1499 slice B: the identity whose line to read, instead of the environment's. */
  readonly as?: string;
  /** ISS-1499 slice B: the clock for the recent-lines window (tests). */
  readonly now?: Date;
}

/** Uncached tail reads a `latest` or `template` selection may make, and bodies the raw fill may skip. */
const READER_MAX_READS = 200;

/** The template's window: the standing `count: 10, brief: true` read. */
const TEMPLATE_WINDOW = 10;

/** `--as`, when given, must be a valid client task id. */
function readerIdentity(as: string | undefined): string | null {
  if (as !== undefined && normalizeClientTaskId(as) === null) {
    throw new CliValidationError("invalid_input", "--as is not a valid client task id.");
  }
  return currentClientTaskId(as);
}

interface ReaderSelection {
  readonly tails: TailReader;
  readonly memo: MemoResolution;
  readonly selection: HandoverSelection;
  /** `latest` only: the recent scan, run before the selection. */
  readonly scan: RecentScan | null;
}

/**
 * Plan sections 4, 7 and 8: the caller's memo, the recent scan when a
 * window cutoff is given (`latest` only), then the one selection.
 */
function selectForReader(ctx: CommandContext, taskId: string | null, count: number, cutoff: string | null = null): ReaderSelection {
  const listing = ctx.state.handoverFilenames;
  const tails = new TailReader(ctx.handoversDir, listing);
  const memo = resolveLineMemo(resolve(ctx.root), taskId, tails);
  const scan = cutoff === null ? null : scanRecentTails({ listing, tails, cutoff });
  const selection = selectHandovers({ listing, tails, memo, count, maxReads: READER_MAX_READS });
  return { tails, memo, selection, scan };
}

/** The window's date rule follows the board's filename rule; an unreadable config reads as local dates. */
async function windowCutoff(root: string, now: Date): Promise<string> {
  let team = false;
  try { team = await detectTeamMode(resolve(root)); } catch { team = false; }
  return recentCutoff(now, team);
}

/** `lines` exists only with a notice or a block; never `{ notices: [] }`. */
function linesOf(notices: readonly string[], otherLines: OtherLines | undefined): HandoverLinesAddition | undefined {
  if (notices.length === 0 && otherLines === undefined) return undefined;
  return otherLines === undefined ? { notices } : { notices, otherLines };
}

/**
 * Amendment C2's assertion: with no lineage observed the selection is the
 * listing's own slice. A difference is a bug, and the slice wins.
 */
function compatibleFiles(listing: readonly string[], count: number, files: readonly string[]): readonly string[] {
  const slice = listing.slice(0, count);
  return isDeepStrictEqual([...files], slice) ? files : slice;
}

export async function handleHandoverLatest(
  ctx: CommandContext,
  count: number = 1,
  opts: HandoverLatestOptions = {},
): Promise<CommandResult> {
  const taskId = readerIdentity(opts.as);
  if (ctx.state.handoverFilenames.length === 0) {
    return {
      output: formatError("not_found", "No handovers found", ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  const listing = ctx.state.handoverFilenames;
  const cutoff = await windowCutoff(ctx.root, opts.now ?? new Date());
  const { tails, memo, selection, scan } = selectForReader(ctx, taskId, count, cutoff);
  const recentFor = (selected: readonly string[]): RecentLines => finaliseRecentLines({
    listing, tails, scan: scan!, selection, selected, memo, admitted: isFilenameAdmitted,
  });

  // T-320 commit 2: brief/priming are additive -- omitting both keeps the
  // default path below byte-identical to today (always the full raw body).
  if (opts.brief || opts.priming) {
    const observed = tails.observation.seen;
    // The read limit cannot leave positions open at a count of ten or
    // fewer; should it, the selection stops there (a fill is raw only).
    const filenames = observed ? selection.files : compatibleFiles(listing, count, selection.files);
    // T-320: the admission gate runs BEFORE any filesystem validation -- an
    // oversized filename must be skippable (and counted) without ever
    // reaching parseHandoverFilename's lstat, which throws on a symlink and
    // would otherwise fail the whole request instead of just dropping it.
    for (const filename of filenames) {
      if (isFilenameAdmitted(filename)) {
        await parseHandoverFilename(filename, ctx.handoversDir);
      }
    }
    try {
      const meter = { used: 0 };
      const result = await buildHandoverBrief(ctx.handoversDir, filenames, {
        brief: opts.brief ?? false,
        priming: opts.priming ?? false,
        meter,
      });
      const empty = filenames.length === 0;
      let lines: HandoverLinesAddition | undefined;
      if (observed) {
        // After the selection and after the caller's own window was built,
        // which nothing below changes.
        const rl = recentFor(filenames);
        const notices = selectionNotices(memo, selection, selection.limited || selection.fill !== null || rl.limited, empty, listing.length);
        const otherLines = opts.brief
          ? buildBriefOtherLines(rl, notices, CROSS_HANDOVER_BUDGET - meter.used, ctx.format, ctx.handoversDir)
          : buildRawOtherLines(rl);
        lines = linesOf(notices, otherLines);
      }
      // buildHandoverBrief drops a listed-but-missing file (ENOENT) from the
      // window itself rather than failing the whole request -- matching the
      // default path's own tolerance for a missing file when count > 1.
      // not_found applies only when NOTHING is left to report: an empty
      // window AND no admission skips. If every filename was instead
      // rejected for an oversized name (skippedHandovers > 0), that is a
      // real, observable result (the files exist) and must render through
      // formatHandoverBrief's own skipped-count message, not collapse into
      // a misleading "not found". An empty default line (ISS-1499 slice B)
      // is a success that carries its notice.
      if (result.handovers.length === 0 && result.skippedHandovers === 0 && !(empty && observed)) {
        return {
          output: formatError("not_found", "No handovers found", ctx.format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "not_found",
        };
      }
      return { output: formatHandoverBrief(result, ctx.format, lines) };
    } catch (err: unknown) {
      return {
        output: formatError("io_error", `Cannot read handover: ${(err as Error).message}`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "io_error",
      };
    }
  }

  // The raw body pass (plan section 9): one ordered loop over the selected
  // names and then the fill's, each name validated and read exactly as
  // main does, with main's early return. No fill name is touched until
  // every selected name has passed.
  const bodies: Array<{ readonly filename: string; readonly content: string }> = [];
  type BodyRead = { readonly kind: "missing" } | { readonly kind: "body"; readonly content: string } | { readonly kind: "error"; readonly result: CommandResult };
  const readOne = async (filename: string): Promise<BodyRead> => {
    await parseHandoverFilename(filename, ctx.handoversDir);
    try {
      return { kind: "body", content: readHandoverBody(ctx.handoversDir, filename) };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Skip missing files silently when loading multiple
        if (count > 1) return { kind: "missing" };
        return { kind: "error", result: {
          output: formatError("not_found", `Handover file not found: ${filename}`, ctx.format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "not_found",
        } };
      }
      return { kind: "error", result: {
        output: formatError("io_error", `Cannot read handover: ${(err as Error).message}`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "io_error",
      } };
    }
  };

  const readAll = async (names: readonly string[], into: Array<{ filename: string; content: string }>): Promise<CommandResult | null> => {
    for (const filename of names) {
      const got = await readOne(filename);
      if (got.kind === "missing") continue;
      if (got.kind === "error") return got.result;
      into.push({ filename, content: got.content });
    }
    return null;
  };
  const failed = await readAll(selection.files, bodies);
  if (failed !== null) return failed;

  // The fill (plan section 7): positions the read limit left open, with no
  // linked state seen. A body read here is classified on its own bytes; a
  // linked one is skipped, never returned, and marks lineage as seen. A
  // body that cannot be read takes its position, as on main.
  const selected = [...selection.files];
  let fillLimited = false;
  let walked = selection.walked;
  let endReached = selection.endReached;
  if (selection.fill !== null) {
    let open = selection.fill.open;
    let skipped = 0;
    let j = selection.fill.from;
    for (; j < listing.length && open > 0; j++) {
      const filename = listing[j]!;
      const got = await readOne(filename);
      if (got.kind === "error") return got.result;
      if (got.kind === "body" && readLineage(got.content).kind === "linked") {
        tails.observation.seen = true;
        if (++skipped >= READER_MAX_READS) { j++; fillLimited = true; break; }
        continue;
      }
      selected.push(filename);
      if (got.kind === "body") bodies.push({ filename, content: got.content });
      open--;
    }
    walked = j;
    endReached = !fillLimited && j >= listing.length;
  }

  const observed = tails.observation.seen;
  if (!observed && !isDeepStrictEqual(selected, listing.slice(0, count))) {
    // Amendment C2's assertion (see compatibleFiles): the slice wins.
    bodies.length = 0;
    const again = await readAll(listing.slice(0, count), bodies);
    if (again !== null) return again;
  }
  const empty = selection.source === "default" && selected.length === 0;
  let lines: HandoverLinesAddition | undefined;
  if (observed) {
    const rl = recentFor(selected);
    const notices = selectionNotices(memo, { ...selection, walked, endReached }, selection.limited || fillLimited || rl.limited, empty, listing.length);
    lines = linesOf(notices, buildRawOtherLines(rl));
  }

  if (bodies.length === 0) {
    if (empty && lines !== undefined) return { output: formatHandoverEmptyDefault(lines, ctx.format) };
    return {
      output: formatError("not_found", "No handovers found", ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  // C-v4.1 commit 7: the ledger-state line per handover, full mode only.
  const ledger = opts.ledger ? await ledgerStates(ctx.root, bodies.map((b) => join(ctx.handoversDir, b.filename)), ledgerOptions(ctx.state.config)) : undefined;
  const parts = bodies.map((b, i) => {
    const rendered = formatHandoverContent(
      b.filename,
      splitLineage(b.content).body,
      ctx.format,
      i === bodies.length - 1 ? lines : undefined,
    );
    return ledger ? withLedgerState(rendered, ctx.format, ledger.get(join(ctx.handoversDir, b.filename)) ?? null) : rendered;
  });
  if (lines !== undefined && ctx.format !== "json") parts.push(formatHandoverLinesMd(lines));
  const separator = ctx.format === "json" ? "\n" : "\n\n---\n\n";
  return { output: parts.join(separator) };
}

export async function handleHandoverGet(
  filename: string,
  ctx: CommandContext,
  opts: { readonly ledger?: boolean } = {},
): Promise<CommandResult> {
  await parseHandoverFilename(filename, ctx.handoversDir);

  try {
    const content = await readHandover(ctx.handoversDir, filename);
    const rendered = formatHandoverContent(filename, content, ctx.format);
    if (!opts.ledger) return { output: rendered };
    const s = await ledgerState(ctx.root, join(ctx.handoversDir, filename), ledgerOptions(ctx.state.config));
    return { output: withLedgerState(rendered, ctx.format, s) };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        output: formatError("not_found", `Handover not found: ${filename}`, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "not_found",
      };
    }
    return {
      output: formatError("io_error", `Cannot read handover: ${(err as Error).message}`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "io_error",
    };
  }
}

export interface HandoverTemplateOptions {
  /** Body of an `Override:` line, without the `Override: ` prefix (e.g. "recommended=T-1 worked=T-2 because=owner said so"). */
  readonly override?: string;
  /** ISS-1499 slice B: the identity whose line to scaffold from. */
  readonly as?: string;
  /** ISS-1499 slice B: start a new line; nothing is carried forward. */
  readonly newLine?: boolean;
  /** With `newLine`: the new line's role label. */
  readonly role?: string;
  /** With `newLine`: the handover the new line branches from. */
  readonly from?: string;
}

/**
 * T-498 Commit 1: scaffolds a new handover document -- category headings, a
 * `Carried forward` section derived from the standing `count:10 brief:true`
 * trajectory (with the earlier-of-two-dates preservation rule against
 * whatever the CURRENT newest handover already recorded), an optional
 * validated `Override:` line, and the `<!-- storybloq-handover v1 -->`
 * marker. Read-only: never writes a file (pipe the output into `handover
 * create --stdin` to actually save it).
 */
export async function handleHandoverTemplate(
  ctx: CommandContext,
  opts: HandoverTemplateOptions = {},
): Promise<CommandResult> {
  let override: OverrideLine | null = null;
  if (opts.override !== undefined) {
    override = parseOverrideBody(opts.override);
    if (override === null) {
      throw new CliValidationError(
        "invalid_input",
        "Invalid --override grammar. Expected: recommended=<id> worked=<id> because=<text>",
      );
    }
  }

  // Branch 1: the line attributes belong to --new-line only.
  if ((opts.role !== undefined || opts.from !== undefined) && opts.newLine !== true) {
    throw new CliValidationError("invalid_input", "--role and --from need --new-line.");
  }
  const taskId = readerIdentity(opts.as);

  // Branch 2: an explicit new line, decided before the memo is read. The
  // first-handover scaffold, with the trailer slice A's serializer makes.
  if (opts.newLine === true) {
    const ser = serializeLineage({ role: opts.role ?? null, from: opts.from ?? null });
    if (ser.dropped.length > 0) {
      throw new CliValidationError("invalid_input", `Invalid --${ser.dropped[0]!.attribute} value.`);
    }
    const content = appendLineage(renderHandoverTemplate({ carriedForward: [], override }), ser.line);
    return { output: formatHandoverTemplate(content, ctx.format) };
  }

  // Branches 3 to 5: the selection decides the window.
  const listing = ctx.state.handoverFilenames;
  let filenames: readonly string[] = listing;
  let trailer: string | null = null;
  if (listing.length > 0) {
    const { tails, memo, selection } = selectForReader(ctx, taskId, TEMPLATE_WINDOW);
    if (!tails.observation.seen) {
      filenames = compatibleFiles(listing, TEMPLATE_WINDOW, selection.files);
    } else {
      filenames = selection.files;
      if (memo.kind === "active") trailer = serializeLineage({ continues: memo.tip }).line;
    }
  }

  let previousCarried: CarriedForwardEntry[] = [];
  let trajectory: readonly TrajectoryEntry[] = [];
  const currentLabels = new Map<string, string>();

  if (filenames.length > 0) {
    const newest = filenames[0] as string;
    // Same admission + symlink/traversal rejection every other handover read
    // path runs before touching the file -- an oversized name is skipped
    // (matching the brief/priming tolerance), but a rejected name (path
    // traversal, symlink) throws and is NOT silently treated as "no prior
    // carried state."
    if (isFilenameAdmitted(newest)) {
      await parseHandoverFilename(newest, ctx.handoversDir);
      try {
        const raw = splitLineage(readHandoverBody(ctx.handoversDir, newest)).body;
        if (raw.includes(HANDOVER_TEMPLATE_MARKER)) {
          previousCarried = parseCarriedForwardSection(raw);
        }
      } catch (err: unknown) {
        // ENOENT (listed but deleted since the state scan) is the one
        // tolerated case -- proceed with no prior carried state, same as a
        // brand-new project. Anything else (permission error, etc.) is a
        // real I/O failure and must not be reported as a successful,
        // silently-empty scaffold.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    const windowFilenames = filenames.slice(0, TEMPLATE_WINDOW);
    for (const filename of windowFilenames) {
      if (isFilenameAdmitted(filename)) {
        await parseHandoverFilename(filename, ctx.handoversDir);
      }
    }
    // No blanket catch here: buildHandoverBrief already tolerates a missing
    // (ENOENT) window entry internally (see handleHandoverLatest's brief
    // path) -- any error it does throw is a real failure and must propagate
    // as io_error, not collapse into a falsely-successful empty scaffold.
    const result = await buildHandoverBrief(ctx.handoversDir, windowFilenames, {
      brief: true,
      priming: false,
    });
    trajectory = result.trajectory;
    const first = result.handovers[0];
    if (first && first.form === "structured") {
      for (const record of first.records) {
        if (record.id) currentLabels.set(record.id, record.label);
      }
    }
  }

  const carriedForward = computeCarriedForward(trajectory, previousCarried, currentLabels);
  const scaffold = renderHandoverTemplate({ carriedForward, override });
  const content = trailer === null ? scaffold : appendLineage(scaffold, trailer);
  return { output: formatHandoverTemplate(content, ctx.format) };
}

// --- Create ---

/**
 * Normalizes a slug for handover filenames.
 * Trim, lowercase, whitespace→hyphen, strip non [a-z0-9-], max 60 chars.
 */
export function normalizeSlug(raw: string): string {
  let slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-$/, "");
  if (!slug) {
    throw new CliValidationError(
      "invalid_input",
      `Slug is empty after normalization: "${raw}"`,
    );
  }
  return slug;
}

// ISS-701: delegate config reading to the single shared detector
// (detectTeamModeFromDisk) and apply handover's own degradation policy on top:
// a missing config means a non-team project (use sequential filenames), but a
// malformed/unreadable config is a real error and propagates.
async function detectTeamMode(absRoot: string): Promise<boolean> {
  try {
    return await detectTeamModeFromDisk(absRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// --- Lineage (ISS-1499 slice A, plan section 5) ---

/** The lineage flags of `handover create` (CLI only; MCP carries lineage as a line in the content). */
export interface HandoverCreateLineage {
  readonly continues?: string;
  readonly newLine?: boolean;
  readonly role?: string;
  readonly from?: string;
  readonly absorbs?: readonly string[];
  /**
   * Earlier occurrences of a singleton flag given more than once (plan
   * clarification 9): the last occurrence applies, each earlier one is named.
   */
  readonly ignoredRepeats?: readonly { readonly flag: string; readonly value: string }[];
}

/**
 * Turns the parsed yargs values of the lineage flags into one
 * HandoverCreateLineage. yargs gives an array for a string flag given twice;
 * for `--continues`, `--role` and `--from` the last occurrence applies and
 * every earlier one is kept in `ignoredRepeats`. `--new-line` is a boolean,
 * which yargs folds to one value, and a repeat drops no value, so it is
 * never named (plan clarification 11). Never throws. `--absorbs` is the only
 * repeatable flag.
 */
export function lineageFlagsFromArgv(argv: Readonly<Record<string, unknown>>): HandoverCreateLineage {
  const ignoredRepeats: { flag: string; value: string }[] = [];
  const single = (flag: string, raw: unknown): string | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const all = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v));
    for (const v of all.slice(0, -1)) ignoredRepeats.push({ flag, value: v });
    return all[all.length - 1];
  };
  const rawAbsorbs = argv.absorbs;
  const absorbs = rawAbsorbs === undefined || rawAbsorbs === null
    ? undefined
    : (Array.isArray(rawAbsorbs) ? rawAbsorbs : [rawAbsorbs]).map((v) => String(v));
  return {
    continues: single("--continues", argv.continues),
    newLine: argv["new-line"] === true,
    role: single("--role", argv.role),
    from: single("--from", argv.from),
    absorbs,
    ignoredRepeats,
  };
}

/** A repeated flag's ignored value is echoed only when it passes that flag's value rule. */
function echoableRepeat(flag: string, value: string): string | null {
  if (flag === "--role") return isLineageRoleValue(value) ? value : null;
  return isLineageFileValue(value) ? value : null;
}

/**
 * The write-time check (plan 5.3 step 5): true when appending the lineage
 * line changes nothing any reader derives from the handover. Compares, for
 * `body` and `final`, every derivation a reader makes from a handover's text:
 * the section records (brief, recommend), the carried-forward bullets and
 * heading (template, validate), and the federation heading (scanner, digest,
 * session compact). Raw delivery (`handover latest`/`get`) shows the line
 * as is, by design.
 */
export function lineageIsInvisible(body: string, final: string, file: string): boolean {
  return (
    isDeepStrictEqual(parseHandoverMarkdown(body, file), parseHandoverMarkdown(final, file)) &&
    isDeepStrictEqual(parseCarriedForwardSection(body), parseCarriedForwardSection(final)) &&
    hasCarriedForwardHeading(body) === hasCarriedForwardHeading(final) &&
    extractHandoverHeading(body) === extractHandoverHeading(final)
  );
}

const warn = (code: LineageWarningCode, target: string | null = null, detail: string | null = null): LineageWarning => ({ code, target, detail });

const UNLINKED: Omit<CreateLineageResult, "warnings"> = {
  linked: false, continues: null, from: null, absorbs: [], role: null, at: null, by: null, forkChildren: [],
};

/** What to write, decided before the lock from the content and the flags alone. */
type LineagePlan =
  | { readonly kind: "none" }
  | { readonly kind: "unlinked"; readonly bytes: string; readonly warnings: readonly LineageWarning[] }
  | {
      readonly kind: "linked";
      /** The unlinked fallback bytes (5.3), and the body the line is appended to. */
      readonly fallback: string;
      readonly continues: string | null;
      readonly from: string | null;
      readonly absorbs: readonly string[];
      readonly role: string | null;
      /** A role was given (flag or content line), so it is not copied from the parent. */
      readonly roleGiven: boolean;
      readonly warnings: readonly LineageWarning[];
    };

function planLineage(content: string, flags: HandoverCreateLineage | null): LineagePlan {
  const f = flags ?? {};
  const modifiers: string[] = [];
  if (f.role !== undefined) modifiers.push("--role");
  if (f.from !== undefined) modifiers.push("--from");
  if ((f.absorbs?.length ?? 0) > 0) modifiers.push("--absorbs");
  const hasSelector = f.continues !== undefined || f.newLine === true;
  const repeats = f.ignoredRepeats ?? [];
  const split = splitLineage(content);
  if (!hasSelector && modifiers.length === 0 && repeats.length === 0 && split.lineage === null) return { kind: "none" };

  const warnings: LineageWarning[] = [];
  for (const r of repeats) warnings.push(warn("modifier_ignored", echoableRepeat(r.flag, r.value), r.flag));
  // Any v1 line at the end of the content belongs to the tool and is removed.
  const fallback = split.lineage === null ? content : split.body;
  if (f.continues !== undefined && f.newLine === true) warnings.push(warn("new_line_ignored"));
  if (split.lineage !== null && hasSelector) warnings.push(warn("content_line_discarded"));
  for (let i = 0; i < split.discarded.length; i++) warnings.push(warn("content_line_discarded"));

  let continues: ContinuesState;
  let from: string | null = null;
  let role: string | null = null;
  let absorbs: string[] = [];
  if (f.continues !== undefined) {
    continues = isLineageFileValue(f.continues) ? { state: "valid", file: f.continues } : { state: "invalid" };
  } else if (f.newLine === true) {
    continues = { state: "absent" };
  } else if (split.lineage !== null) {
    const l = split.lineage.lineage;
    continues = l.continues;
    from = l.from;
    role = l.role;
    absorbs = [...l.absorbs];
    for (const d of split.lineage.dropped) {
      // `at` and `by` are recomputed whatever the line said; an invalid
      // continues is named once, by continues_invalid (clarification 10).
      if (d.attribute === "at" || d.attribute === "by") continue;
      if (d.attribute === "continues" && d.reason === "invalid") continue;
      warnings.push(warn("attribute_dropped", null, `${d.attribute}:${d.reason}`));
    }
  } else {
    // (Slice B inserts the memo here, between the content line and "none".)
    for (const m of modifiers) warnings.push(warn("modifier_ignored", null, m));
    return { kind: "unlinked", bytes: content, warnings };
  }

  if (continues.state === "invalid") {
    warnings.push(warn("continues_invalid"));
    for (const m of modifiers) warnings.push(warn("modifier_ignored", null, m));
    return { kind: "unlinked", bytes: fallback, warnings };
  }

  let roleGiven = role !== null;
  if (f.role !== undefined) {
    role = f.role;
    roleGiven = true;
  }
  if (f.from !== undefined) from = f.from;
  if (continues.state === "valid" && from !== null) {
    warnings.push(warn("from_dropped", isLineageFileValue(from) ? from : null));
    from = null;
  }
  absorbs.push(...(f.absorbs ?? []));
  return {
    kind: "linked",
    fallback,
    continues: continues.state === "valid" ? continues.file : null,
    from,
    absorbs,
    role,
    roleGiven,
    warnings,
  };
}

/**
 * Clarification 8: an empty handover file is never written. A fallback
 * whose bytes trim to empty (content that was only a lineage line) is
 * refused with main's own empty-content error, before anything is written.
 */
function refuseEmptyFallback(bytes: string): void {
  if (!bytes.trim()) throw new CliValidationError("invalid_input", "Handover content is empty");
}

function gitShortHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/**
 * Plan 5.3 steps 1 to 5, inside the project lock: scan, fork report,
 * absorbs, compose, write-time check. Returns the bytes to write and the
 * reply's lineage result. Never throws because of a handover file.
 */
async function resolveLinkedWrite(
  plan: Extract<LineagePlan, { kind: "linked" }>,
  handoversDir: string,
  absRoot: string,
  at: string | null,
  by: string | null,
): Promise<{ bytes: string; result: CreateLineageResult }> {
  const listWarnings: LoadWarning[] = [];
  const names = await listHandovers(handoversDir, absRoot, listWarnings);
  const enumerated = !listWarnings.some((w) => w.type === "parse_error");
  const scan = scanHandoverLineage(handoversDir, enumerated ? names : [], enumerated);
  const graph = buildLineageGraph(scan);
  const byName = new Map(scan.files.map((x) => [x.name, x]));

  const found: LineageWarning[] = [];
  let forkChildren: string[] = [];
  let role = plan.role;
  const parent = plan.continues;
  if (!enumerated) {
    found.push(warn("scan_failed"));
  } else {
    if (parent !== null) {
      const entry = byName.get(parent);
      if (entry === undefined) found.push(warn("parent_not_in_checkout", parent));
      else if (entry.state === "unknown") found.push(warn("parent_unreadable", parent));
      else {
        forkChildren = [...(graph.certainChildren.get(parent) ?? [])];
        if (!plan.roleGiven && entry.state === "linked") role = entry.lineage?.lineage.role ?? null;
      }
    }
    if (!scan.complete) {
      const unread = scan.files.filter((x) => x.state === "unknown").length;
      found.push(warn("scan_incomplete", null, String(unread)));
    }
  }

  const tips = new Set(graph.tips);
  const kept: string[] = [];
  const seen = new Set<string>();
  const drop = (target: string | null, reason: AbsorbDropReason) => found.push(warn("absorb_dropped", target, reason));
  for (const a of plan.absorbs) {
    if (!isLineageFileValue(a)) { drop(null, "invalid"); continue; }
    if (seen.has(a)) continue;
    seen.add(a);
    if (!scan.complete) drop(a, "scan_incomplete");
    else if (a === parent) drop(a, "is_parent");
    else if (!byName.has(a)) drop(a, "not_found");
    else if (!tips.has(a)) drop(a, "not_a_tip");
    else kept.push(a);
  }

  const ser = serializeLineage({
    continues: parent,
    from: plan.from,
    absorbs: kept,
    role,
    at: at !== null && isLineageAtValue(at) ? at : null,
    by: by !== null && isLineageByValue(by) ? by : null,
  });
  for (const d of ser.dropped) found.push(warn("attribute_dropped", null, `${d.attribute}:${d.reason}`));

  const final = appendLineage(plan.fallback, ser.line);
  const check = splitLineage(final);
  const holds = check.lineage !== null && check.discarded.length === 0 && lineageIsInvisible(plan.fallback, final, "handover.md");
  if (!holds) {
    return { bytes: plan.fallback, result: { ...UNLINKED, warnings: [...plan.warnings, warn("parser_check_failed")] } };
  }
  const l = ser.lineage;
  return {
    bytes: final,
    result: {
      linked: true,
      continues: parent,
      from: l.from,
      absorbs: [...l.absorbs],
      role: l.role,
      at: l.at,
      by: l.by,
      forkChildren,
      warnings: [...plan.warnings, ...found],
    },
  };
}

/**
 * Creates a handover markdown file.
 * Runs inside withProjectLock for atomic filename allocation + write.
 */
export async function handleHandoverCreate(
  content: string,
  slugRaw: string,
  format: OutputFormat,
  root: string,
  /** T-499: the caller's identity for the handover stamp; `stamp: false` skips it (tests, batch tooling). */
  intel: {
    readonly clientTaskId?: string | null;
    readonly stamp?: boolean;
    readonly now?: number;
    readonly projectsDir?: string;
    /**
     * ISS-1214: which surface is asking. It decides which skips are worth
     * reporting (a terminal is never a Claude session; an MCP caller always
     * should be) and whether a server-staleness claim can be made at all.
     */
    readonly surface?: "mcp" | "cli";
  } = {},
  /** ISS-1499: the CLI lineage flags. MCP passes none; a content line still applies. */
  lineage: HandoverCreateLineage | null = null,
): Promise<CommandResult> {
  if (!content.trim()) {
    throw new CliValidationError("invalid_input", "Handover content is empty");
  }

  const slug = normalizeSlug(slugRaw);
  const date = handoverFilenameDate(new Date(), false);
  let filename: string | undefined;
  const absRoot = resolve(root);
  const plan = planLineage(content, lineage);
  let lineageResult: CreateLineageResult | null = null;
  let toWrite = content;
  if (plan.kind === "unlinked") {
    toWrite = plan.bytes;
    lineageResult = { ...UNLINKED, warnings: plan.warnings };
    refuseEmptyFallback(toWrite);
  }
  // `at` and `by` are read before the lock is taken.
  let at: string | null = null;
  let by: string | null = null;
  if (plan.kind === "linked") {
    const { gitUserEmail } = await import("../../autonomous/git-inspector.js");
    [at, by] = await Promise.all([gitShortHead(absRoot), gitUserEmail(absRoot)]);
  }

  await withProjectLock(root, { strict: false }, async () => {
    const handoversDir = join(absRoot, ".story", "handovers");
    await mkdir(handoversDir, { recursive: true });
    const wrapDir = join(absRoot, ".story");

    if (plan.kind === "linked") {
      const r = await resolveLinkedWrite(plan, handoversDir, absRoot, at, by);
      toWrite = r.bytes;
      lineageResult = r.result;
      refuseEmptyFallback(toWrite);
    }

    const isTeamMode = await detectTeamMode(absRoot);

    if (isTeamMode) {
      const { generateTeamHandoverFilename } = await import("../../core/handover-filename.js");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { randomBytes } = await import("node:crypto");
      let attempt = 0;
      while (attempt < 5) {
        const candidate = generateTeamHandoverFilename(slug);
        const candidatePath = join(handoversDir, candidate);
        const tmpPath = join(handoversDir, `.tmp-${randomBytes(4).toString("hex")}`);
        let tmpCreated = false;
        try {
          await parseHandoverFilename(candidate, handoversDir);
          await guardPath(candidatePath, wrapDir);
          writeFileSync(tmpPath, toWrite, "utf-8");
          tmpCreated = true;
          await fencedLink(tmpPath, candidatePath);
          recordBoardTarget(candidatePath, "write");
          filename = candidate;
          try { unlinkSync(tmpPath); } catch {}
          tmpCreated = false;
          break;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            attempt++;
            continue;
          }
          throw err;
        } finally {
          if (tmpCreated) {
            try { unlinkSync(tmpPath); } catch {}
          }
        }
      }
      if (!filename) {
        throw new CliValidationError("conflict", "Failed to create unique handover filename after 5 retries");
      }
    } else {
      const seqRegex = new RegExp(`^${date}-(\\d{2})-`);
      let maxSeq = 0;

      const { readdirSync } = await import("node:fs");
      try {
        for (const f of readdirSync(handoversDir)) {
          const m = f.match(seqRegex);
          if (m) {
            const n = parseInt(m[1]!, 10);
            if (n > maxSeq) maxSeq = n;
          }
        }
      } catch {
        // dir empty or unreadable
      }

      let nextSeq = maxSeq + 1;
      if (nextSeq > 99) {
        throw new CliValidationError("conflict", `Too many handovers for ${date}; limit is 99 per day`);
      }

      let candidate = `${date}-${String(nextSeq).padStart(2, "0")}-${slug}.md`;
      let candidatePath = join(handoversDir, candidate);

      while (existsSync(candidatePath)) {
        nextSeq++;
        if (nextSeq > 99) {
          throw new CliValidationError("conflict", `Too many handovers for ${date}; limit is 99 per day`);
        }
        candidate = `${date}-${String(nextSeq).padStart(2, "0")}-${slug}.md`;
        candidatePath = join(handoversDir, candidate);
      }

      await parseHandoverFilename(candidate, handoversDir);
      await guardPath(candidatePath, wrapDir);
      await atomicWrite(candidatePath, toWrite);
      filename = candidate;
    }
  });

  // T-499: the handover is on disk; record it against the caller's current
  // compaction boundary so imperative pressure is held at advisory until the
  // context grows by a step or the next compaction. Best-effort, after the
  // project lock is released, never affecting the result.
  let stamped = false;
  let stampedRoot: string | null = null;
  // ISS-1197 commit 2: past the compact line the stamp still lands, but it
  // suppresses nothing, so the reply must not claim it did.
  let compactNeeded = false;
  // ISS-1214: why an attempted stamp did not land, so the reply cannot read
  // as success while the record keeps `handoverWrittenAt: null` and the
  // prompt hook re-fires the imperative with no visible cause.
  let stampFailure: HandoverStampFailure | null = null;
  let serverStale = false;
  // ISS-1263: how the stamp bound, and the re-arm interval the reply quotes.
  let stampBinding: "bound" | "unbound-era" = "bound";
  let rearmIntervalMs = 600_000;
  if (intel.stamp !== false) {
    try {
      const { describeStampFailure, stampHandoverForCaller } = await import("../../core/session-intel/push.js");
      const { readSessionIntelConfig } = await import("../../core/session-intel/config.js");
      rearmIntervalMs = readSessionIntelConfig(root).handoverRearmIntervalMs;
      const r = stampHandoverForCaller(root, { explicitTaskId: intel.clientTaskId, cwd: root, now: intel.now, projectsDir: intel.projectsDir });
      // Only a stamp whose locked write LANDED counts: a busy lock, a failed
      // write, or a refusal under the lock leaves the record unchanged.
      stamped = r.status === "stamped" && r.outcome.status === "written";
      if (stamped && r.status === "stamped") {
        stampedRoot = r.root;
        compactNeeded = r.pressureState === "compact-needed";
        stampBinding = r.binding;
      } else {
        stampFailure = describeStampFailure(r, intel.surface ?? "cli");
      }
    } catch (err) {
      // Reached only if the import or the stamp itself throws. Silent before
      // ISS-1214, which is the exact shape that hid the field-report failure.
      stampFailure = { reason: `error: ${err instanceof Error ? err.message : String(err)}`, kind: "error" };
    }
    // Only the MCP surface can answer this: the staleness question is about a
    // long-lived server process against the build on disk, and a CLI process
    // was just spawned from that build. Asked only when there is a failure to
    // explain, so the ordinary path does not pay for it.
    if (stampFailure !== null && intel.surface === "mcp") {
      try {
        const { describeBinaryStaleness } = await import("../../autonomous/binary-staleness.js");
        serverStale = describeBinaryStaleness() !== null;
      } catch {
        serverStale = false;
      }
    }
  }

  // The continuation line rides only on a landed stamp: an unbound caller
  // (or a stamp that missed) gets the bare result, so the line never claims
  // a suppression that did not happen. ISS-1185: stampedRoot is reported
  // only when it diverges from the MCP root (formatHandoverCreateResult
  // gates on that itself).
  return { output: formatHandoverCreateResult(filename!, format, stamped, stampedRoot, absRoot, compactNeeded, stampFailure, serverStale, stampBinding, rearmIntervalMs, lineageResult) };
}
