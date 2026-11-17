/**
 * T-320 commit 2: `brief`/`priming` modes for `handover_latest`, built on
 * commit 1's per-document parser (markdown-sections.ts). This module is the
 * cross-handover orchestrator: it decides, per requested handover, whether
 * to return the raw body or a structured record form, and applies the
 * cross-handover byte budget across the whole requested window.
 *
 * Two independent flags, not a mode enum (T-320's amendment supersedes the
 * ticket's original "mode: summary" idea):
 * - `brief`: every handover in the window uses the STRUCTURED form.
 * - `priming`: a handover uses its RAW body unless that body exceeds
 *   `PRIMING_RAW_BODY_MAX_BYTES` (12,000 -- T-497's per-handover trigger),
 *   in which case it falls back to the same structured form `brief` uses.
 * Both set: structured wins (brief's always-on is a superset).
 * Neither set: unchanged from today -- always the raw body, byte for byte.
 *
 * T-497's "12,000-byte cap" is ONLY this per-handover raw-body trigger, not a
 * second structured-output cap: every structured byte is governed by T-320's
 * own amendment (1,600/handover -- markdown-sections.ts's CAP_BYTES -- and
 * the H=14,200 cross-handover budget below), confirmed by the pen after a
 * real conflict was found between the two ticket texts (T-320 is later and
 * more precise, and its numbers are already load-bearing in shipped commit-1
 * code).
 */
import { splitLineage } from "./handover-lineage.js";
import { readHandoverBody } from "./handover-selection.js";
import {
  parseHandoverMarkdown,
  selectBoundedRecords,
  selectContinuationCandidates,
  buildTrajectory,
  buildIndex,
  type SectionRecord,
  type ContinuationIndex,
  type ContinuationCandidatesResult,
  type TrajectoryEntry,
  type TrajectoryHandoverInput,
} from "./markdown-sections.js";

/** T-497: per-handover raw-body trigger for `priming`. At or under stays raw; over downgrades. */
export const PRIMING_RAW_BODY_MAX_BYTES = 12_000;

/** T-320 amendment: brief/priming admit only handovers whose JSON-escaped filename fits this. */
const FILENAME_ADMISSION_MAX_BYTES = 300;

/**
 * Whether a filename is admitted into brief/priming (T-320 amendment). Kept
 * as its own predicate, and checked by the CALLER before any filesystem
 * validation (parseHandoverFilename's symlink lstat included) runs on that
 * name -- an oversized name must be droppable without ever touching disk.
 */
export function isFilenameAdmitted(filename: string): boolean {
  return byteLength(JSON.stringify(filename)) <= FILENAME_ADMISSION_MAX_BYTES;
}

/**
 * T-320 amendment: H = 16,000 total minus the 1,600-byte trajectory cap
 * minus a 200-byte wrapper reserve. Governs only the STRUCTURED slice of the
 * response (raw-body entries, capped individually at 12,000 bytes by the
 * priming trigger, are not summed against this -- a response of several
 * small raw bodies is not what this budget is protecting).
 */
const CROSS_HANDOVER_BUDGET_BYTES = 14_200;

const TRAJECTORY_CAP_BYTES = 1600;

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

export interface RawEntry {
  filename: string;
  form: "raw";
  body: string;
}

export interface StructuredEntry {
  filename: string;
  form: "structured";
  records: SectionRecord[];
  index: ContinuationIndex | null;
  /**
   * T-498 design decision 1: line-one candidates for the NEWEST handover
   * only (`handovers[0]`), own separately-reserved 800-byte budget -- added
   * after the cross-handover budget decision below, never drawn from it.
   */
  continuationCandidates?: ContinuationCandidatesResult;
}

export interface IndexOnlyEntry {
  filename: string;
  form: "index-only";
  index: ContinuationIndex;
}

export type HandoverBriefEntry = RawEntry | StructuredEntry | IndexOnlyEntry;

export interface HandoverBriefResult {
  handovers: HandoverBriefEntry[];
  trajectory: TrajectoryEntry[];
  /** Handovers admitted into the count but dropped for an oversized filename. */
  skippedHandovers: number;
  /**
   * Handovers listed by the caller (and filename-admitted) but no longer on
   * disk when read was attempted -- e.g. deleted or renamed between the
   * state scan and this call. Dropped from the window rather than failing
   * the whole request, matching the default (no-flags) path's own tolerance
   * for a missing file when more than one was requested.
   */
  missingHandovers: number;
}

export interface HandoverBriefOptions {
  brief: boolean;
  priming: boolean;
}

interface PreparedStructured {
  filename: string;
  full: { records: SectionRecord[]; index: ContinuationIndex | null };
  indexOnly: ContinuationIndex;
  occurrences: TrajectoryHandoverInput;
  /** Full, unbounded parse output -- the input `selectContinuationCandidates` needs, since its 800-byte budget is independent of the 1,600-byte display cap already applied to `full.records`. */
  allRecords: SectionRecord[];
}

type Prepared = { filename: string; kind: "raw"; body: string } | { filename: string; kind: "structured"; data: PreparedStructured };

function structuredEntryBytes(filename: string, form: "structured" | "index-only", body: { records?: SectionRecord[]; index: ContinuationIndex | null }): number {
  return byteLength(JSON.stringify({ filename, form, ...body }));
}

/**
 * Cross-handover H-budget walk, newest to oldest. `prepared` is only the
 * subset of requested handovers that resolved to structured form (raw
 * entries never enter this walk). The newest structured entry is never
 * demoted; every other one is included in full only if doing so still
 * leaves room for the ACTUAL index-only bytes of every structured handover
 * older than it -- so a big handover near the front does not starve small
 * ones further back into a demotion they never needed.
 */
function allocateCrossHandoverBudget(prepared: PreparedStructured[]): HandoverBriefEntry[] {
  const fullBytes = prepared.map((p) => structuredEntryBytes(p.filename, "structured", p.full));
  const indexOnlyBytes = prepared.map((p) => structuredEntryBytes(p.filename, "index-only", { index: p.indexOnly }));

  const suffixIndexReserve = new Array<number>(prepared.length + 1).fill(0);
  for (let i = prepared.length - 1; i >= 0; i--) {
    suffixIndexReserve[i] = (suffixIndexReserve[i + 1] as number) + (indexOnlyBytes[i] as number);
  }

  const results: HandoverBriefEntry[] = [];
  let running = 0;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i] as PreparedStructured;
    const reserveForRest = suffixIndexReserve[i + 1] as number;
    const tryFull = running + (fullBytes[i] as number) + reserveForRest;
    if (i === 0 || tryFull <= CROSS_HANDOVER_BUDGET_BYTES) {
      results.push({ filename: p.filename, form: "structured", records: p.full.records, index: p.full.index });
      running += fullBytes[i] as number;
    } else {
      results.push({ filename: p.filename, form: "index-only", index: p.indexOnly });
      running += indexOnlyBytes[i] as number;
    }
  }
  return results;
}

/**
 * Truncates the trajectory list to `TRAJECTORY_CAP_BYTES`. No eviction
 * order is specified on the ticket for this list (unlike records, which
 * have an explicit decision-reserve rule); ordering by occurrenceCount
 * descending, then id ascending for determinism, keeps the entries most
 * corroborated across the window when something has to be dropped.
 */
function capTrajectory(entries: TrajectoryEntry[]): TrajectoryEntry[] {
  const sorted = [...entries].sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.id.localeCompare(b.id));
  const kept: TrajectoryEntry[] = [];
  for (const entry of sorted) {
    const candidate = [...kept, entry];
    if (byteLength(JSON.stringify(candidate)) <= TRAJECTORY_CAP_BYTES) {
      kept.push(entry);
    } else {
      break;
    }
  }
  return kept;
}

/**
 * Builds the brief/priming response for a window of handovers, newest
 * first. `filenames` is expected already sliced to the requested count
 * (`handover_latest`'s existing `count` cap of 10 applies upstream).
 */
export async function buildHandoverBrief(
  handoversDir: string,
  filenames: readonly string[],
  opts: HandoverBriefOptions,
): Promise<HandoverBriefResult> {
  let skippedHandovers = 0;
  const admitted: string[] = [];
  for (const filename of filenames) {
    if (isFilenameAdmitted(filename)) {
      admitted.push(filename);
    } else {
      skippedHandovers++;
    }
  }

  let missingHandovers = 0;
  const prepared: Prepared[] = [];
  for (const filename of admitted) {
    let body: string;
    try {
      // ISS-1499 slice B: the one body reader, and the lineage line removed
      // before anything is measured, parsed or returned.
      body = splitLineage(readHandoverBody(handoversDir, filename)).body;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missingHandovers++;
        continue;
      }
      throw err;
    }
    const wantsStructured = opts.brief || (opts.priming && byteLength(body) > PRIMING_RAW_BODY_MAX_BYTES);
    if (!wantsStructured) {
      prepared.push({ filename, kind: "raw", body });
      continue;
    }

    const parsed = parseHandoverMarkdown(body, filename);
    const full = selectBoundedRecords(parsed.records, filename);
    const allIds = parsed.records
      .map((r) => r.id)
      .filter((id): id is string => id !== null);
    const indexOnly = buildIndex(parsed.records.length, allIds, filename);
    prepared.push({
      filename,
      kind: "structured",
      data: {
        filename,
        full,
        indexOnly,
        occurrences: { filename, orderedIdOccurrences: parsed.orderedIdOccurrences },
        allRecords: parsed.records,
      },
    });
  }

  const structuredPrepared = prepared
    .filter((p): p is Extract<Prepared, { kind: "structured" }> => p.kind === "structured")
    .map((p) => p.data);
  const budgeted = allocateCrossHandoverBudget(structuredPrepared);
  let budgetedIdx = 0;

  const firstPrepared = prepared[0];
  const firstCandidates: ContinuationCandidatesResult | undefined =
    firstPrepared && firstPrepared.kind === "structured"
      ? selectContinuationCandidates(firstPrepared.data.allRecords, firstPrepared.filename)
      : undefined;

  const handovers: HandoverBriefEntry[] = prepared.map((p, i) => {
    if (p.kind === "raw") return { filename: p.filename, form: "raw", body: p.body };
    const entry = budgeted[budgetedIdx] as HandoverBriefEntry;
    budgetedIdx++;
    if (i === 0 && entry.form === "structured" && firstCandidates) {
      return { ...entry, continuationCandidates: firstCandidates };
    }
    return entry;
  });

  const trajectoryInputs = structuredPrepared.map((p) => p.occurrences);
  const trajectory = capTrajectory(buildTrajectory(trajectoryInputs));

  return { handovers, trajectory, skippedHandovers, missingHandovers };
}
