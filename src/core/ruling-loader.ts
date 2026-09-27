import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { RulingSchema, type Ruling } from "../models/ruling.js";
import { RULING_CANONICAL_ID_REGEX } from "../models/types.js";
import { atomicCreate, atomicWrite, guardPath, serializeJSON } from "./project-loader.js";
import { ProjectLoaderError } from "./errors.js";
import { sanitizeDisplayText } from "./display-text.js";
import { collapseBoundedRead, readBoundedFileDetailed, type BoundedReader } from "./bounded-read.js";
import { buildCitationResolutionContext, buildSuccessorIndex, lifecycleMapFor, type CitationResolutionContext, type UpwardBoard } from "./ruling.js";
import type { RulingLifecycle } from "./ruling-lifecycle.js";
import { readdirSafe, verifyContainment, verifyDirIdentity } from "./readdir-safe.js";
import { resolveOrchestratorRoot, type OrchestratorRootResult } from "../federation/resolver.js";

/**
 * A ruling is a short attributed quote plus a handful of scalar fields -- a
 * few hundred bytes to a few KB in the ordinary case. 256 KiB leaves
 * generous headroom for an unusually long verbatim quote while keeping a
 * corrupt or hostile multi-MB file from being read in full. Enforced against
 * the FULL serialized record (see `writeRulingUnlocked`), not `--text` alone:
 * JSON escaping, `scopeTags`, and `recordedBy` all add bytes a text-only
 * check would miss, and a text-only check cannot cover every write path
 * (e.g. create-and-supersede, which never goes through the CLI's own arg
 * parsing).
 */
export const RULING_MAX_BYTES = 262_144;

/**
 * Mirrors `session-guard.ts`'s `ScanCompleteness` (ISS-897's lesson: a
 * clean-looking answer over an incomplete scan is not a clean answer),
 * reused by name/shape rather than reinvented. `loadRulingsSafe` only ever
 * returns "complete" or "incomplete" -- "unknown" is reserved for a
 * not-yet-attempted scan, which this synchronous loader never represents.
 */
export type RulingScanCompleteness = "complete" | "incomplete" | "unknown";

export interface LoadRulingsResult {
  readonly rulings: readonly Ruling[];
  readonly warnings: readonly string[];
  /**
   * Canonical id (recovered from the FILENAME, which survives content
   * corruption) for every `.story/rulings/*.json` entry that existed but
   * failed to parse/validate/name-match. Lets a citation resolver distinguish
   * "this id never existed" (missing) from "this id exists but is currently
   * unreadable" (unreadable) -- a structural fact from the scan, not a guess
   * parsed from a warning string.
   */
  readonly unavailableIds: ReadonlySet<string>;
  /**
   * "incomplete" only when `.story/rulings/` itself could not be enumerated
   * (permission error, not-a-directory, etc.) -- NOT for an ordinary missing
   * directory (every pre-T-476 project), which is the normal empty-project
   * state and reports "complete" with zero rulings.
   */
  readonly scanCompleteness: RulingScanCompleteness;
  /**
   * True whenever a `.json` entry was skipped (not-a-regular-file, unreadable/
   * oversized, invalid JSON, or schema mismatch) AND its id could not be
   * recovered from its filename either (codex round-3 finding: `unavailableIds`
   * alone cannot represent this case, since there is no id to add). Content
   * that could not even be parsed might still carry any `supersedes` edge, so
   * this must taint "nothing supersedes X" conclusions project-wide exactly
   * like a nonempty `unavailableIds` already does -- distinct from it only
   * because no SPECIFIC id is known to attach the taint to.
   */
  readonly hasUnrecoverableEntries: boolean;
  /**
   * T-522: derived lifecycle per LOADED record. A quarantined or conflicted
   * record is a readable file that parsed, so it lives in `rulings` and here,
   * never in `unavailableIds` -- it taints only its own chain, not the whole
   * id-space.
   */
  readonly lifecycleById: ReadonlyMap<string, RulingLifecycle>;
}

/**
 * Fail-safe, SYNCHRONOUS read of every ruling on disk (T-476), mirroring
 * `loadArrangementsSafe` exactly: never throws, skip-and-warn per file, a
 * missing `.story/rulings/` directory is the ordinary empty-project state.
 *
 * T-528: `read` defaults to the shipped bounded reader. The decisions
 * projection passes a recording reader, so it parses rulings through this
 * exact function while keeping the bytes each record was parsed from.
 */
export function loadRulingsSafe(root: string, read: BoundedReader = readBoundedFileDetailed): LoadRulingsResult {
  const dir = resolve(root, ".story", "rulings");
  const scan = readdirSafe(dir);
  if (scan.warning !== null) {
    return {
      rulings: [],
      warnings: [`Could not read .story/rulings/: ${sanitizeDisplayText(scan.warning)}`],
      unavailableIds: new Set(),
      scanCompleteness: "incomplete",
      hasUnrecoverableEntries: false,
      lifecycleById: new Map(),
    };
  }
  if (scan.dirents === null) {
    return { rulings: [], warnings: [], unavailableIds: new Set(), scanCompleteness: "complete", hasUnrecoverableEntries: false, lifecycleById: new Map() };
  }

  const rulings: Ruling[] = [];
  const warnings: string[] = [];
  const unavailableIds = new Set<string>();
  let hasUnrecoverableEntries = false;

  const recoverIdFromFilename = (file: string): string | null => {
    const base = file.endsWith(".json") ? file.slice(0, -".json".length) : file;
    return RULING_CANONICAL_ID_REGEX.test(base) ? base : null;
  };

  for (const entry of scan.dirents) {
    const file = entry.name;
    if (!file.endsWith(".json")) continue;
    // Only ordinary regular files: a symlink or other special node must
    // never be able to hang or exhaust memory on a synchronous read.
    if (!entry.isFile()) {
      warnings.push(`rulings/${sanitizeDisplayText(file)}: not a regular file, skipped`);
      const recovered = recoverIdFromFilename(file);
      if (recovered) unavailableIds.add(recovered);
      else hasUnrecoverableEntries = true;
      continue;
    }
    // Containment check (ISS-1053, T-478): a symlinked ancestor path
    // component swapped in between the listing and this read must not let
    // this read escape `dir`. Same taint doctrine as every other skip below:
    // recover the id from the filename if possible, else the whole scan is
    // tainted for "nothing supersedes X" purposes.
    const containmentWarning = verifyContainment(dir, file);
    if (containmentWarning !== null) {
      warnings.push(`rulings/${sanitizeDisplayText(file)}: ${sanitizeDisplayText(containmentWarning)}`);
      const recovered = recoverIdFromFilename(file);
      if (recovered) unavailableIds.add(recovered);
      else hasUnrecoverableEntries = true;
      continue;
    }
    const path = join(dir, file);
    const raw = collapseBoundedRead(read(path, RULING_MAX_BYTES));
    if (raw === null) {
      warnings.push(`rulings/${sanitizeDisplayText(file)}: unreadable, empty, or exceeds size limit, skipped`);
      const recovered = recoverIdFromFilename(file);
      if (recovered) unavailableIds.add(recovered);
      else hasUnrecoverableEntries = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`rulings/${sanitizeDisplayText(file)}: invalid JSON`);
      const recovered = recoverIdFromFilename(file);
      if (recovered) unavailableIds.add(recovered);
      else hasUnrecoverableEntries = true;
      continue;
    }
    const result = RulingSchema.safeParse(parsed);
    if (!result.success) {
      warnings.push(`rulings/${sanitizeDisplayText(file)}: schema mismatch`);
      const recovered = recoverIdFromFilename(file);
      if (recovered) unavailableIds.add(recovered);
      else hasUnrecoverableEntries = true;
      continue;
    }
    // Same filename-must-equal-id discipline as `loadArrangementsSafe`: makes
    // a same-id duplicate directory entry structurally impossible, and keeps
    // the lookup key (filename) and the record's own claimed id from ever
    // silently diverging.
    if (file !== `${result.data.id}.json`) {
      warnings.push(`rulings/${sanitizeDisplayText(file)}: filename does not match record id, skipped`);
      // Unlike the failure branches above, the content here parsed cleanly --
      // its OWN claimed id (from the validated record, not a filename guess)
      // is known and real. Mark THAT id unavailable: the record (and any
      // `supersedes` edge it carries) is genuinely on disk but excluded from
      // `rulings`, so a citation resolver must not treat its target as
      // current without knowing this successor exists and is unreadable
      // through the normal path. Also attempt filename recovery in case the
      // two disagree (e.g. a copy sitting under the ORIGINAL's old name).
      unavailableIds.add(result.data.id);
      const recovered = recoverIdFromFilename(file);
      if (recovered) unavailableIds.add(recovered);
      continue;
    }
    rulings.push(result.data);
  }
  if (scan.dirIdentity !== null) {
    const postScanWarning = verifyDirIdentity(dir, scan.dirIdentity);
    if (postScanWarning !== null) {
      // Any content read during a since-detected-swapped window is
      // retroactively suspect once the swap is confirmed -- discard the
      // whole scan result (not per-id: we no longer trust which ids were
      // validly present) and taint every "nothing supersedes X" conclusion.
      return {
        rulings: [],
        warnings: [`Could not read .story/rulings/: ${sanitizeDisplayText(postScanWarning)}`],
        unavailableIds: new Set(),
        scanCompleteness: "incomplete",
        hasUnrecoverableEntries: true,
        lifecycleById: new Map(),
      };
    }
  }
  const lifecycleById = lifecycleMapFor(rulings, buildSuccessorIndex(rulings));
  return { rulings, warnings, unavailableIds, scanCompleteness: "complete", hasUnrecoverableEntries, lifecycleById };
}

/**
 * Loads rulings and builds a `CitationResolutionContext` in one call -- the
 * one entry point render command handlers use (`loadRulingsSafe` plus
 * `buildCitationResolutionContext`, called once per command, never once per
 * rendered item).
 */
export function loadCitationContext(root: string): CitationResolutionContext {
  const { rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries } = loadRulingsSafe(root);
  return buildCitationResolutionContext(rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries);
}

/**
 * T-520: the ONE function in this feature that reads another board.
 *
 * Returns the ordinary local context, plus the orchestrator's board when --
 * and only when -- both of these hold:
 *
 *   1. something is actually cited. No citations, no conclusions to draw, so
 *      there is nothing an orchestrator read could change. This is what keeps
 *      the cost off every project that does not cite rulings.
 *   2. this project records an `orchestrator` pointer. That field was declared
 *      but never written before this ticket, so "no pointer" is the state of
 *      every existing project and it takes the early return: byte-identical to
 *      the behaviour before the leg existed.
 *
 * The gate is deliberately NOT "did a citation miss locally". It cannot be:
 * both the unreadable-orchestrator taint and the cross-board supersession
 * check apply to citations that resolved perfectly well on this board, and
 * both are facts you only learn BY READING the other one. Gating on a miss
 * would have silently disabled both for exactly the citations that look
 * healthiest.
 *
 * What the gate buys, and nothing more: zero orchestrator IO for a project
 * with no citations or no pointer, and ONE bounded read per call rather than
 * one per citation.
 *
 * Read-only throughout: `loadRulingsSafe` never writes, never locks, and never
 * throws, so no lock is taken on a board this project does not own.
 */
export function buildCitationInputs(
  root: string,
  citedIds: readonly string[],
): CitationResolutionContext {
  const local = loadCitationContext(root);
  if (citedIds.length === 0) return local;

  const upward = loadUpwardBoard(root);
  return upward ? { ...local, upward } : local;
}

/**
 * T-520: the orchestrator's board, or `undefined` when this project is not a
 * linked node.
 *
 * Split out from `buildCitationInputs` because `validateProject` is pure and
 * takes the board through its `aux` bag rather than building a context, so
 * both shapes have to come from ONE loader. The gate on "is anything cited"
 * lives in the callers, which is where the citation list is.
 */
export function loadUpwardBoard(root: string): UpwardBoard | undefined {
  return loadUpwardBoardAt(resolveOrchestratorRoot(root));
}

/**
 * T-528: the same board, from a pointer the caller already resolved (the
 * decisions projection resolves it from the `config.json` bytes it hashed).
 */
export function loadUpwardBoardAt(pointer: OrchestratorRootResult): UpwardBoard | undefined {
  if (!pointer.ok) {
    // Not a linked node: the overwhelmingly common case, and the one that must
    // not change. A RECORDED pointer we could not follow is a different thing
    // and is reported, because a federation seat is entitled to know that the
    // board it was told to consult is not there.
    if (pointer.code === "no-pointer") return undefined;
    return {
      kind: "unreadable",
      ...(pointer.attempted !== undefined && { attemptedPath: pointer.attempted }),
      reason: pointer.reason,
    };
  }

  const scan = loadRulingsSafe(pointer.root);
  if (scan.scanCompleteness !== "complete") {
    // The directory itself could not be enumerated. Partial knowledge of
    // another board is not knowledge of it: treated exactly like a pointer we
    // could not follow, never as an empty board (which would turn every
    // upward citation into a confident `missing`).
    return { kind: "unreadable", attemptedPath: pointer.root, reason: "ruling ledger could not be read" };
  }
  return {
    kind: "board",
    root: pointer.root,
    ctx: buildCitationResolutionContext(
      scan.rulings, scan.unavailableIds, scan.scanCompleteness, scan.hasUnrecoverableEntries,
    ),
  };
}

/**
 * T-520: the board for a caller that holds the citing entities rather than a
 * list of ids -- `validateProject`'s three call sites, all of which have
 * tickets and issues in hand and none of which should read another board when
 * nothing on this one cites anything.
 *
 * Takes the entities structurally rather than a `ProjectState` so this module
 * keeps its current import surface.
 */
export function loadUpwardBoardFor(
  root: string,
  entities: ReadonlyArray<{ readonly citesRulings?: readonly string[] }>,
): UpwardBoard | undefined {
  const cites = entities.some((e) => (e.citesRulings?.length ?? 0) > 0);
  return cites ? loadUpwardBoard(root) : undefined;
}

/**
 * Writes a ruling file WITHOUT acquiring the project lock. Use inside
 * `withProjectLock` when the lock is already held, mirroring
 * `writeArrangementUnlocked`'s usage exactly.
 *
 * A ruling's `text`/`attribution`/`recordedBy`/`date`/`id` are immutable once
 * created; `supersedes` may be set exactly once, from `null`, by
 * `ruling supersede` (see `src/core/ruling.ts`). That single mutation still
 * goes through this same function with `createOnly` omitted.
 */
/**
 * Validates a ruling, ensures `.story/rulings` exists, and resolves the target,
 * WITHOUT writing anything.
 *
 * T-494: `runTransactionUnlocked` carries none of these invariants, so a caller
 * that writes a ruling through the transaction runs them here instead, and
 * `writeRulingUnlocked` calls the same function so the two cannot drift. Two of
 * these are not cosmetic. The `mkdir` is what lets the FIRST ruling in a project
 * exist at all: without it the transaction's temp write fails ENOENT. The
 * `RULING_MAX_BYTES` check on the SERIALIZED record is what stops a write-only
 * ruling, because `readBoundedFile` above applies the same bound and would
 * refuse to read back anything larger.
 *
 * `mkdir` and `guardPath` are effects rather than content, and they deliberately
 * run here, before any transaction begins, so a failure lands in the
 * pre-commit half where nothing has been renamed.
 */
export async function prepareRulingWrite(
  ruling: Ruling,
  root: string,
): Promise<{ target: string; content: string }> {
  const parsed = RulingSchema.parse(ruling);
  if (!RULING_CANONICAL_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError("invalid_input", `Invalid ruling ID: ${parsed.id}`);
  }
  const content = serializeJSON(parsed);
  if (Buffer.byteLength(content, "utf8") > RULING_MAX_BYTES) {
    throw new ProjectLoaderError("invalid_input", `Ruling record exceeds ${RULING_MAX_BYTES} bytes`);
  }
  const wrapDir = resolve(root, ".story");
  const target = join(wrapDir, "rulings", `${parsed.id}.json`);
  await mkdir(dirname(target), { recursive: true });
  await guardPath(target, wrapDir);
  return { target, content };
}

export async function writeRulingUnlocked(
  ruling: Ruling,
  root: string,
  options?: { createOnly?: boolean },
): Promise<void> {
  const { target, content } = await prepareRulingWrite(ruling, root);
  if (options?.createOnly) {
    await atomicCreate(target, content);
  } else {
    await atomicWrite(target, content);
  }
}
