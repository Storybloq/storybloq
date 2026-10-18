/**
 * T-523: freshness and discovery for the capability inventory.
 *
 * Two jobs live here, and neither of them loads the file. `checkCapabilities`
 * takes entries and answers "is this entry still true at HEAD"; `matchCapabilities`
 * takes entries and answers "which of these is the task about". Both are given
 * their entries by the caller, so the catalog load path is a separate concern
 * and neither of these needs a lock, a transaction or a filesystem read of the
 * catalog itself.
 *
 * The rule the whole module serves (C-C): a search that finds nothing has
 * searched the INVENTORY and nothing else. "No match" is never evidence that
 * no implementation exists, so every result carries what was searched and how
 * big the searched set was.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep, isAbsolute } from "node:path";
import { titleWords } from "./catalog.js";
import { sanitizeDisplayPath, sanitizeDisplayText } from "./display-text.js";
import { loadRulingsSafe } from "./ruling-loader.js";
import { glossaryCatalog } from "./glossary.js";
import { COMMANDS, MCP_TOOLS } from "../cli/commands/reference.js";
import { entryPointViolations, hasPendingNote, normalizeEntryPoint, type Capability, type EntryPointRule } from "../models/capability.js";
import type { ProjectState } from "./project-state.js";
import type { LedgerSnapshot } from "./ledger-snapshot.js";

const execFileAsync = promisify(execFile);

/** One git subprocess may take this long before it is killed. */
export const GIT_SUBPROCESS_TIMEOUT_MS = 10_000;

/**
 * The whole check may take this long. At the deadline, running subprocesses
 * are killed and nothing further is SCHEDULED: a check that cannot finish
 * reports what it does not know rather than blocking a session start.
 */
export const CHECK_DEADLINE_MS = 30_000;

/** Git subprocesses in flight at once. */
export const CHECK_CONCURRENCY = 4;

/**
 * Result classes, because they are treated differently by the writers.
 *
 * FRESHNESS says the entry may have drifted; the recovery is to re-inspect and
 * re-stamp, so `check --stamp` clears it. STRUCTURAL says the entry is broken
 * as written; stamping must NOT clear it, which is why stamping refuses on a
 * structural error. INCOMPLETE says the check could not run; it is never
 * reported as `current`, because "I could not look" and "I looked and it is
 * fine" are the confusion this whole inventory exists to prevent.
 */
export type CheckResultClass = "freshness" | "structural" | "incomplete";

export type CapabilityCheckCode =
  | "capability_changed"
  | "capability_unverifiable_checkpoint"
  | "capability_missing_path"
  | "capability_path_escape"
  | "capability_symlinked_path"
  | "capability_unknown_ruling"
  | "capability_unknown_item"
  | "capability_unknown_term"
  | "capability_unknown_surface"
  | "capability_conflicted"
  | "capability_invariant_problem"
  | "capability_check_timeout"
  | "capability_check_incomplete";

export interface CapabilityCheckResult {
  readonly code: CapabilityCheckCode;
  readonly cls: CheckResultClass;
  /**
   * Human-readable, already safe to print. Every path in it went through
   * `sanitizeDisplayPath` (an address, so the reversible form) and every other
   * unconstrained label through `sanitizeDisplayText`: an entry point, a
   * surface name, a symlink's real path and git's list of changed files may
   * all carry control, line-separator or bidi characters. Ids and shas are
   * bound by their schemas' patterns and are interpolated as they are.
   */
  readonly detail: string;
}

export interface CapabilityCheckEntry {
  readonly id: string;
  readonly storedStatus: Capability["status"];
  readonly effectiveStatus: Capability["status"];
  readonly results: readonly CapabilityCheckResult[];
  /** T-526 (3.7): the stored pending note when one is set, else null. A set note forces `review`. */
  readonly pendingNote: string | null;
}

export interface CapabilityCheckReport {
  readonly entries: readonly CapabilityCheckEntry[];
  /** HEAD at the moment the check started, or null when it could not be read. */
  readonly head: string | null;
  /** Entry ids whose freshness could not be determined. */
  readonly unchecked: readonly string[];
  /** Git subprocesses actually spawned; asserted by the batching test. */
  readonly gitCalls: number;
  readonly deadlineHit: boolean;
  /**
   * Present when the check ran against a ledger snapshot: references were
   * resolved against that commit's ledger, while path existence, symlinks and
   * surfaces were still checked on the WORKING TREE. Said on the result so it
   * is never read as a historical filesystem check.
   */
  readonly filesystemChecks?: "working-tree";
  /** The snapshot's commit when one was used. */
  readonly snapshotCommit?: string;
}

export interface CheckOptions {
  /** Skip the git work entirely (`--no-check`); structural checks still run. */
  readonly skipFreshness?: boolean;
  /**
   * Entry ids named by an unresolved conflict record, and ids failing a
   * document invariant. Both are owned by the catalog load path, which hands
   * them in rather than being reached from here.
   */
  readonly conflictedIds?: ReadonlySet<string>;
  readonly problemIds?: ReadonlySet<string>;
  readonly now?: () => number;
  /**
   * The git subprocess, replaceable so a test can take the machine out of a
   * measurement. The real one carries a per-call timeout and the check's abort
   * signal, both wall-clock: under load they kill calls, and a test counting
   * subprocesses then measures the load rather than the batching.
   */
  readonly runGit?: GitRunner;
  /**
   * T-526 (3.2): resolve `rulings`, `items` and `terms` against the ledger at
   * this commit rather than the working tree. An `oid-unavailable` snapshot or
   * an unreadable family makes the affected references incomplete, never
   * unknown.
   */
  readonly snapshot?: LedgerSnapshot;
  /**
   * Compute freshness against this commit instead of reading HEAD. It is the
   * `head` the report returns and the commit a stamp would certify.
   */
  readonly headOid?: string;
}

const FRESHNESS_CODES: ReadonlySet<CapabilityCheckCode> = new Set([
  "capability_changed",
  "capability_unverifiable_checkpoint",
]);

/**
 * A result is present at all only when something is wrong or unknown, so the
 * effective status is simply "stored review, or anything to report".
 */
export function effectiveStatus(
  storedStatus: Capability["status"],
  results: readonly CapabilityCheckResult[],
  pending = false,
): Capability["status"] {
  return storedStatus === "review" || results.length > 0 || pending ? "review" : "current";
}

/** True when `child` is `parent` or sits underneath it on a SEGMENT boundary. */
export function isPathWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

function result(code: CapabilityCheckCode, cls: CheckResultClass, detail: string): CapabilityCheckResult {
  return { code, cls, detail };
}

// --- git ---

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  /**
   * Read for its PRESENCE only, never its text, which git translates and
   * rewords between versions. Its first line may be quoted as evidence.
   */
  readonly stderr: string;
  /** Non-zero exit is a legitimate ANSWER for is-ancestor, not a failure. */
  readonly exitCode: number | null;
}

/**
 * `lazyFetch: false` asks git about THIS repository's objects only. In a
 * partial clone git otherwise fetches a missing object from the promisor
 * remote on demand, so a lookup can reach the network and write the store.
 * The runner owns how that is spelled; callers do not pass environment.
 */
export interface GitCallOptions {
  readonly lazyFetch?: boolean;
}

export type GitRunner = (
  root: string,
  args: readonly string[],
  signal: AbortSignal,
  options?: GitCallOptions,
) => Promise<GitOutcome>;

/**
 * One git invocation. A non-zero exit is returned rather than thrown, because
 * `merge-base --is-ancestor` communicates its answer that way; a kill, a
 * timeout or a spawn failure comes back as `ok: false` with a null exit code,
 * which is what the caller turns into "incomplete" rather than "false".
 */
async function runGit(root: string, args: readonly string[], signal: AbortSignal, options: GitCallOptions = {}): Promise<GitOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      timeout: GIT_SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      signal,
      // The environment variable, not `git --no-lazy-fetch`: a git older than
      // the option DIES on an unknown global option, which would make every
      // such call fail, while it ignores an unknown variable and simply keeps
      // fetching. MERGED into the inherited environment, never a replacement:
      // a replaced one loses PATH and HOME and every call fails, which reads as
      // "incomplete" everywhere rather than as a bug.
      ...(options.lazyFetch === false ? { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } } : {}),
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    const killed = e.killed === true || typeof e.signal === "string" || e.code === "ABORT_ERR";
    const exitCode = typeof e.code === "number" ? e.code : null;
    return { ok: !killed && exitCode !== null, stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: killed ? null : exitCode };
  }
}

/**
 * The current HEAD commit, or null when it cannot be read.
 *
 * Exported because `add` and `check --stamp` both write a checkpoint and both
 * must write the SAME kind of value the freshness check later reads: a full
 * commit oid that `rev-parse --verify <sha>^{commit}` resolves. A caller that
 * built its own sha string could produce a checkpoint that every later check
 * reports as unverifiable, which reads as "this entry is suspect" rather than
 * "the writer used the wrong command".
 */
export async function resolveHead(root: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIT_SUBPROCESS_TIMEOUT_MS);
  try {
    const out = await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"], controller.signal);
    return out.ok && out.exitCode === 0 ? out.stdout.trim() || null : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `--name-only -z` is NUL-delimited, which is the only form that survives a
 * path containing a newline or a quote. Git emits a trailing NUL, so the final
 * empty field is dropped rather than counted as a changed path.
 */
function parseNulList(stdout: string): string[] {
  return stdout.split("\0").filter((s) => s.length > 0);
}

/**
 * `:(literal)` disables pathspec magic for the whole string, so an entry point
 * containing `*`, `?`, `[x]`, a leading `:` or a space is matched as the exact
 * bytes it is rather than as a glob. Without it, an entry point named `a*b`
 * would silently widen the diff to everything matching that pattern, and the
 * entry would look changed whenever an unrelated sibling changed.
 */
function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

// --- structural checks ---

/**
 * A structural finding asserts something about the repository, so it may only
 * be raised when the check actually saw the repository say so. ENOENT and
 * ENOTDIR are the repository saying the path as written does not exist; every
 * other code (EACCES, EPERM, EIO, ELOOP, ...) is the check failing to see, and
 * becomes `capability_check_incomplete`, which is not stampable. This is the
 * same line `readBoundedFileDetailed` in `src/core/limit-config.ts` draws
 * between `absent` and `indeterminate`, so no reader of the project draws it
 * anywhere else.
 */
type Probe = { readonly kind: "present" } | { readonly kind: "absent" } | { readonly kind: "unseen"; readonly code: string };

function probe(stat: (path: string) => unknown, path: string): Probe {
  try {
    stat(path);
    return { kind: "present" };
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    // The code is from the OS's closed errno set, never from input, so it is
    // safe to carry into the message.
    return { kind: "unseen", code: typeof code === "string" ? code : "unknown error" };
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The first component of `ep` under `root` that is a symlink, as a repo-relative path. */
function firstSymlinkComponent(root: string, ep: string): string | null {
  const segments = ep.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const rel = segments.slice(0, i).join("/");
    try {
      if (lstatSync(join(root, rel)).isSymbolicLink()) return rel;
    } catch {
      return null;
    }
  }
  return null;
}

function checkEntryPoints(root: string, entry: Capability): CapabilityCheckResult[] {
  const out: CapabilityCheckResult[] = [];
  const realRoot = realpathOrNull(root);
  for (const ep of entry.entryPoints) {
    const full = join(root, ep);
    const entryProbe = probe(lstatSync, full);
    if (entryProbe.kind === "unseen") {
      out.push(
        result("capability_check_incomplete", "incomplete", `could not inspect entry point ${sanitizeDisplayPath(ep)} (${entryProbe.code})`),
      );
      continue;
    }
    if (entryProbe.kind === "absent") {
      out.push(result("capability_missing_path", "structural", `entry point does not exist: ${sanitizeDisplayPath(ep)}`));
      continue;
    }
    // Present as a directory entry, but its target may not resolve. Reported as
    // missing (the inspection target is unreachable) with the cause named, so
    // it is never confused with a path that escapes the root. `statSync`
    // follows the link and draws the same absent/unseen line as above.
    const targetProbe = probe(statSync, full);
    if (targetProbe.kind === "unseen") {
      out.push(
        result(
          "capability_check_incomplete",
          "incomplete",
          `could not resolve the target of entry point ${sanitizeDisplayPath(ep)} (${targetProbe.code})`,
        ),
      );
      continue;
    }
    if (targetProbe.kind === "absent") {
      out.push(
        result("capability_missing_path", "structural", `entry point is a symlink whose target does not resolve: ${sanitizeDisplayPath(ep)}`),
      );
      continue;
    }
    /**
     * No COMPONENT of an entry point may be a symlink, not merely the leaf.
     * Git tracks a symlink as a blob holding the link text, so `src/link` and
     * `src/link/thing.ts` alike are inert: a change to what the link points at
     * never appears in `git diff` under the entry's path, and the entry reports
     * `current` forever. One comparison finds any link on the way: the real
     * path of the whole entry against the real root joined with the entry.
     * The root is realpathed too, or a root reached through a link of its own
     * (macOS `/var` is `/private/var`) would flag every entry in the project.
     *
     * The same comparison replaces a separate containment check: an entry that
     * resolves outside the root has, by construction, a real path that differs
     * from `realRoot/ep`, and naming the link is the actionable half of that
     * finding too.
     */
    const realFull = realpathOrNull(full);
    if (realRoot === null || realFull === null) {
      out.push(result("capability_check_incomplete", "incomplete", `could not resolve the real path of entry point ${sanitizeDisplayPath(ep)}`));
      continue;
    }
    if (realFull === join(realRoot, ep)) continue;
    const link = firstSymlinkComponent(root, ep) ?? ep;
    const rel = relative(realRoot, realFull);
    // An empty `rel` is the root itself: inside, and still not a usable entry
    // point, so it gets its own advice rather than an empty replacement path.
    const inside = !isAbsolute(rel) && rel.split(sep)[0] !== "..";
    if (!inside) {
      out.push(
        result(
          "capability_path_escape",
          "structural",
          `entry point ${sanitizeDisplayPath(ep)} resolves outside the project root through the symlink ${sanitizeDisplayPath(link)}: git cannot watch a path outside the repository at all`,
        ),
      );
      continue;
    }
    const advice =
      rel.length === 0
        ? "it resolves to the repo root, which is not an entry point: choose a concrete entry point beneath the root"
        : `point the entry at the real path ${sanitizeDisplayPath(rel.split(sep).join("/"))}`;
    out.push(
      result(
        "capability_symlinked_path",
        "structural",
        `entry point ${sanitizeDisplayPath(ep)} passes through the symlink ${sanitizeDisplayPath(link)}, and git tracks the link rather than its target, so changes there never make this entry stale: ${advice}`,
      ),
    );
  }
  return out;
}

interface ReferenceIndex {
  readonly rulingIds: ReadonlySet<string>;
  readonly rulingScanIncomplete: boolean;
  /** Rulings whose file exists but could not be read or validated. */
  readonly rulingUnavailableIds: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  /** True when a snapshot's ticket or issue file could not be read, so a missing item id is unresolved, not unknown. */
  readonly itemScanIncomplete: boolean;
  readonly termIds: ReadonlySet<string>;
  /**
   * True when the glossary file EXISTS but could not be loaded. Same taint
   * doctrine as `rulingScanIncomplete` and for the same reason: an unreadable
   * catalog cannot support the claim "this term does not exist".
   *
   * An ABSENT glossary is deliberately NOT tainted. Absence is a determinate
   * answer -- there are no terms, so a reference to one is genuinely unknown
   * -- and treating it as incomplete would downgrade every real dangling term
   * reference to a shrug on the projects most likely to have them.
   */
  readonly termScanIncomplete: boolean;
  readonly cliNames: ReadonlySet<string>;
  readonly mcpNames: ReadonlySet<string>;
}

/**
 * T-524: the glossary ids a capability's `terms` are checked against.
 *
 * Loaded HERE rather than taken from the caller, unlike the capability ids the
 * glossary's own check receives as an argument. The asymmetry is the import
 * direction: `core/glossary.ts` holds its catalog instance precisely so this
 * module can reach it, while the capability catalog is instantiated beside its
 * CLI surface, which core cannot import from.
 *
 * A failed load is reported, never thrown. This is a reference index for a
 * CHECK; a broken glossary is something the check should say, and `validate`
 * reports it in its own right through `glossary_catalog_unreadable`.
 */
function glossaryIds(root: string): { termIds: ReadonlySet<string>; termScanIncomplete: boolean } {
  try {
    return { termIds: new Set(glossaryCatalog.load(root).doc.terms.map((t) => t.id)), termScanIncomplete: false };
  } catch {
    return { termIds: new Set<string>(), termScanIncomplete: true };
  }
}

/** The glossary ids at a snapshot's commit: absent is a determinate empty set, anything else unconcluded is taint. */
function snapshotGlossaryIds(snapshot: LedgerSnapshot): { termIds: ReadonlySet<string>; termScanIncomplete: boolean } {
  const read = snapshot.terms();
  if (read.kind === "ok") return { termIds: new Set(read.entries.map((t) => t.id)), termScanIncomplete: false };
  if (read.kind === "absent") return { termIds: new Set<string>(), termScanIncomplete: false };
  return { termIds: new Set<string>(), termScanIncomplete: true };
}

/** Ticket and issue ids (and display ids) at a snapshot's commit, plus whether any item file failed to read. */
function snapshotItemIds(snapshot: LedgerSnapshot): { ids: Set<string>; incomplete: boolean } {
  const ids = new Set<string>();
  const tickets = snapshot.tickets();
  const issues = snapshot.issues();
  for (const r of [...tickets.records, ...issues.records]) {
    ids.add(r.id);
    const display = (r as { displayId?: string | null }).displayId;
    if (typeof display === "string" && display.length > 0) ids.add(display);
  }
  return { ids, incomplete: !tickets.available || tickets.unreadable.length > 0 || issues.unreadable.length > 0 };
}

function buildReferenceIndex(root: string, state: ProjectState | null, snapshot?: LedgerSnapshot): ReferenceIndex {
  if (snapshot !== undefined) {
    const scan = snapshot.rulingsScan();
    const items = snapshotItemIds(snapshot);
    return {
      rulingIds: new Set(scan.rulings.map((r) => r.id)),
      rulingScanIncomplete: scan.scanCompleteness !== "complete" || scan.hasUnrecoverableEntries,
      rulingUnavailableIds: scan.unavailableIds,
      itemIds: items.ids,
      itemScanIncomplete: items.incomplete,
      ...snapshotGlossaryIds(snapshot),
      cliNames: new Set(COMMANDS.map((c) => c.name)),
      mcpNames: new Set(MCP_TOOLS.map((t) => t.name)),
    };
  }
  const scan = loadRulingsSafe(root);
  const glossary = glossaryIds(root);
  const rulingIds = new Set(scan.rulings.map((r) => r.id));

  const itemIds = new Set<string>();
  for (const t of state?.tickets ?? []) {
    itemIds.add(t.id);
    const display = (t as { displayId?: string | null }).displayId;
    if (typeof display === "string" && display.length > 0) itemIds.add(display);
  }
  for (const i of state?.issues ?? []) {
    itemIds.add(i.id);
    const display = (i as { displayId?: string | null }).displayId;
    if (typeof display === "string" && display.length > 0) itemIds.add(display);
  }

  return {
    rulingIds,
    // The same three conditions validate's citation check requires of a
    // complete scan: an entry skipped with no recoverable id could be ANY
    // ruling, so it taints every "does not exist" conclusion.
    rulingScanIncomplete: scan.scanCompleteness !== "complete" || scan.hasUnrecoverableEntries,
    rulingUnavailableIds: scan.unavailableIds,
    itemIds,
    itemScanIncomplete: false,
    ...glossary,
    cliNames: new Set(COMMANDS.map((c) => c.name)),
    mcpNames: new Set(MCP_TOOLS.map((t) => t.name)),
  };
}

function checkReferences(entry: Capability, index: ReferenceIndex): CapabilityCheckResult[] {
  const out: CapabilityCheckResult[] = [];

  for (const id of entry.rulings ?? []) {
    if (index.rulingIds.has(id)) continue;
    if (index.rulingUnavailableIds.has(id)) {
      // The file exists; this process could not read or validate it. That is
      // not evidence the ruling is unknown.
      out.push(
        result("capability_check_incomplete", "incomplete", `ruling ${id} exists but could not be read or validated, so the reference was not checked`),
      );
      continue;
    }
    if (index.rulingScanIncomplete) {
      // An INCOMPLETE scan cannot support the claim "this id does not exist",
      // so it reports what it does not know instead. Same taint doctrine
      // ruling-loader already applies to itself. Do not "fix" this back to an
      // unknown-ruling error: that would be a false accusation sourced from a
      // directory this process failed to read.
      out.push(
        result("capability_check_incomplete", "incomplete", `ruling ${id} could not be resolved: the rulings scan was incomplete`),
      );
      continue;
    }
    out.push(result("capability_unknown_ruling", "structural", `unknown ruling: ${id}`));
  }
  for (const id of entry.items ?? []) {
    if (index.itemIds.has(id)) continue;
    if (index.itemScanIncomplete) {
      out.push(result("capability_check_incomplete", "incomplete", `item ${id} could not be resolved: an item file in the ledger snapshot could not be read`));
      continue;
    }
    out.push(result("capability_unknown_item", "structural", `unknown item: ${id}`));
  }
  for (const id of entry.terms ?? []) {
    if (index.termIds.has(id)) continue;
    if (index.termScanIncomplete) {
      out.push(result("capability_check_incomplete", "incomplete", `glossary term ${id} could not be resolved: the glossary could not be read`));
      continue;
    }
    out.push(result("capability_unknown_term", "structural", `unknown glossary term: ${id}`));
  }
  for (const { kind, name } of unknownSurfaces(entry.surfaces, index)) {
    out.push(result("capability_unknown_surface", "structural", unknownSurfaceDetail(kind, name)));
  }
  return out;
}

// --- surfaces (ISS-1301) ---
//
// One rule for `capability check` and for the add and update writers, so a
// name a write accepts is never one the next check rejects.

export type SurfaceKind = "cli" | "mcp";

export interface SurfaceNames {
  readonly cliNames: ReadonlySet<string>;
  readonly mcpNames: ReadonlySet<string>;
}

/** The names `storybloq reference` lists, from the registry compiled into this CLI. */
export function referenceSurfaceNames(): SurfaceNames {
  return { cliNames: new Set(COMMANDS.map((c) => c.name)), mcpNames: new Set(MCP_TOOLS.map((t) => t.name)) };
}

export function unknownSurfaces(
  surfaces: { readonly cli?: readonly string[]; readonly mcp?: readonly string[] },
  known: SurfaceNames,
): Array<{ kind: SurfaceKind; name: string }> {
  return [
    ...(surfaces.cli ?? []).filter((n) => !known.cliNames.has(n)).map((name) => ({ kind: "cli" as const, name })),
    ...(surfaces.mcp ?? []).filter((n) => !known.mcpNames.has(n)).map((name) => ({ kind: "mcp" as const, name })),
  ];
}

export function unknownSurfaceDetail(kind: SurfaceKind, name: string): string {
  return kind === "cli"
    ? `no such CLI command in storybloq reference: ${sanitizeDisplayText(name)}`
    : `no such MCP tool in storybloq reference: ${sanitizeDisplayText(name)}`;
}

/**
 * Up to five reference names close to an unknown one, deterministic: for an
 * MCP name the `storybloq_` form, then names in the same group (first word:
 * `ruling` finds `ruling list`), then names that contain it.
 */
export function nearestSurfaceNames(kind: SurfaceKind, name: string, known: SurfaceNames): string[] {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return [];
  const names = [...(kind === "cli" ? known.cliNames : known.mcpNames)].sort();
  const bare = (n: string): string => (kind === "mcp" ? n.toLowerCase().replace(/^storybloq_/, "") : n.toLowerCase());
  const group = (n: string): string => bare(n).split(kind === "mcp" ? "_" : " ")[0]!;
  const want = group(key);
  const out: string[] = [];
  const push = (n: string): void => {
    if (!out.includes(n)) out.push(n);
  };
  if (kind === "mcp" && names.includes(`storybloq_${key}`)) push(`storybloq_${key}`);
  for (const n of names) if (group(n) === want) push(n);
  for (const n of names) if (n.toLowerCase().includes(key)) push(n);
  return out.slice(0, 5);
}

/**
 * T-526 (D4): the reference half of the check for ONE entry, against the
 * working tree. `capability restore` refuses an entry whose links would
 * dangle, and it must reach exactly the rules `check` applies rather than a
 * second copy of them.
 */
export function capabilityReferenceProblems(root: string, state: ProjectState | null, entry: Capability): CapabilityCheckResult[] {
  return checkReferences(entry, buildReferenceIndex(root, state));
}

// --- freshness ---

interface FreshnessGroup {
  readonly sha: string;
  readonly entries: Capability[];
  readonly paths: string[];
}

type GroupOutcome =
  | { readonly kind: "ok"; readonly changed: readonly string[] }
  | { readonly kind: "unverifiable"; readonly detail: string }
  | { readonly kind: "incomplete"; readonly detail: string };

function groupByCheckpoint(entries: readonly Capability[]): FreshnessGroup[] {
  const groups = new Map<string, { entries: Capability[]; paths: Set<string> }>();
  for (const entry of entries) {
    const sha = entry.checkedAt.sha;
    let g = groups.get(sha);
    if (!g) {
      g = { entries: [], paths: new Set() };
      groups.set(sha, g);
    }
    g.entries.push(entry);
    for (const p of entry.entryPoints) g.paths.add(p);
  }
  return [...groups.entries()].map(([sha, g]) => ({ sha, entries: g.entries, paths: [...g.paths].sort() }));
}

/** Longest stretch of git's own stderr quoted in a result detail. */
const GIT_EVIDENCE_MAX = 200;

/**
 * Git's first stderr line as evidence for an incomplete result. It is the
 * user's own repository speaking, but it is external text entering Markdown
 * and JSON output, so it goes through the same sanitizer as every other
 * untrusted value in a report: control, line-separator and bidi characters
 * become `?`, and the length is capped. Taking one line means it cannot open a
 * Markdown line of its own.
 */
function gitEvidence(outcome: GitOutcome): string {
  const line = outcome.stderr.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  return line === undefined ? "" : `: git said "${sanitizeDisplayText(line, GIT_EVIDENCE_MAX)}"`;
}

/** Object types that exist and can never resolve to a commit. `commit` is not here: see below. */
const NON_COMMIT_TYPES: ReadonlySet<string> = new Set(["tree", "blob", "tag"]);

/**
 * The resolve and its probe ask whether THIS repository holds the checkpoint.
 * With lazy fetch on, a partial clone asks the promisor instead: a read-only
 * check reaches the network and writes the store, and when the promisor does
 * not have the object either, its refusal lands on stderr, which the
 * classification below would read as a failure to read, turning a confirmed
 * absence into an incomplete, unstampable entry. On a git too old to know the
 * variable that still happens; it is no worse than without it (ISS-1280). The
 * diff keeps lazy fetch: a treeless clone needs the old trees to answer at all.
 */
const LOCAL_OBJECTS_ONLY: GitCallOptions = { lazyFetch: false };

/**
 * Why a checkpoint did not resolve, claiming only what git said.
 *
 * `rev-parse --verify --quiet` exits 1, with NOTHING on stderr, when git finds
 * no such object: that is git reporting the checkpoint absent, which a shallow
 * clone or a commit rebased away and garbage-collected looks like, and which
 * stays a stampable freshness finding. Everything else has to be established
 * before it may be reported as a fact about the repository.
 *
 * ORDER IS LOAD-BEARING. Exit 128 is git failing to read the object, and it
 * becomes incomplete BEFORE any probe runs, because `cat-file -t` on a corrupt
 * pack answers a type anyway (it answered "tag" on the reproduced one), which
 * would turn a corrupt object into a confident "names a tag".
 *
 * Exit 1 WITH stderr is either an object that is not a commit or git failing to
 * open one, and only git's own type answer separates them. A type that can
 * never resolve to a commit is a finding. Anything else is incomplete,
 * including the answer `commit`: two git calls disagreeing about one object is
 * not a result.
 *
 * Reading stderr for presence has a cost, accepted here: a git that prints an
 * unrelated warning on every call turns an absent checkpoint into incomplete,
 * permanently unstampable for that user. It is the safe direction, and the
 * detail quotes the warning so they can see the cause.
 *
 * Residual (ISS-1279): an unreadable pack file is byte-identical to an absent
 * object at git's interface, so it still reads as absent.
 */
async function classifyUnresolved(
  root: string,
  sha: string,
  resolved: GitOutcome,
  signal: AbortSignal,
  countCall: () => void,
  runGit: GitRunner,
): Promise<GroupOutcome> {
  if (resolved.exitCode !== 1) {
    return { kind: "incomplete", detail: `git could not read checkpoint ${sha} (exit ${resolved.exitCode})${gitEvidence(resolved)}` };
  }
  if (resolved.stderr.length === 0) {
    return {
      kind: "unverifiable",
      detail: `git could not find checkpoint ${sha} in this repository (a shallow clone, or a commit rebased away and garbage-collected, looks like this): re-inspect and re-stamp`,
    };
  }
  countCall();
  const typed = await runGit(root, ["cat-file", "-t", sha], signal, LOCAL_OBJECTS_ONLY);
  const type = typed.stdout.trim();
  if (typed.ok && typed.exitCode === 0 && NON_COMMIT_TYPES.has(type)) {
    return { kind: "unverifiable", detail: `checkpoint ${sha} names a ${type}, which does not resolve to a commit: re-inspect and re-stamp` };
  }
  return { kind: "incomplete", detail: `git could not read checkpoint ${sha}${gitEvidence(resolved)}` };
}

/**
 * Three subprocesses per DISTINCT checkpoint, whatever the entry count: resolve
 * the checkpoint, prove it is an ancestor, diff the union of the group's entry
 * points. A failed resolve costs at most one more. A tree diff between two commits is independent of commit order,
 * branch topology and merge commits, which is why this is a diff rather than a
 * log walk: a change introduced by a merge resolution shows up here and would
 * not show up in a first-parent log.
 */
async function checkGroup(
  root: string,
  group: FreshnessGroup,
  headOid: string,
  signal: AbortSignal,
  countCall: () => void,
  runGit: GitRunner,
): Promise<GroupOutcome> {
  countCall();
  const resolved = await runGit(root, ["rev-parse", "--verify", "--quiet", `${group.sha}^{commit}`], signal, LOCAL_OBJECTS_ONLY);
  if (!resolved.ok) return { kind: "incomplete", detail: `could not resolve checkpoint ${group.sha}` };
  if (resolved.exitCode !== 0) return classifyUnresolved(root, group.sha, resolved, signal, countCall, runGit);
  const oid = resolved.stdout.trim();
  if (oid.length === 0) {
    return { kind: "incomplete", detail: `git resolved checkpoint ${group.sha} but printed no commit id` };
  }

  countCall();
  const ancestor = await runGit(root, ["merge-base", "--is-ancestor", oid, headOid], signal);
  if (!ancestor.ok) return { kind: "incomplete", detail: `could not test whether ${group.sha} is an ancestor of HEAD` };
  // `merge-base --is-ancestor` answers with its exit code: 0 is yes, 1 is NO,
  // and anything else (128 for an unreadable object or a broken repository) is
  // git failing to answer at all. Only a genuine "no" is a freshness finding.
  // Treating every nonzero exit as "no" made a git failure look like a normal,
  // STAMPABLE result, so a check that never established ancestry could still
  // certify the entry.
  if (ancestor.exitCode === 1) {
    return {
      kind: "unverifiable",
      detail: `checkpoint ${group.sha} is not an ancestor of HEAD (divergent branch, or rebased away): re-inspect and re-stamp`,
    };
  }
  if (ancestor.exitCode !== 0) {
    return { kind: "incomplete", detail: `git could not determine whether ${group.sha} is an ancestor of HEAD (exit ${ancestor.exitCode})` };
  }

  countCall();
  // `--no-renames`, because rename detection reports a move by its DESTINATION
  // only. With `src/a` and `src/b` in one group, moving `src/a/x.ts` to
  // `src/b/x.ts` listed only `src/b/x.ts`, so the entry watching `src/a` stayed
  // current, while checking `src/a` alone reported the change: batching changed
  // the answer. It also overrides a user's `diff.renames` setting.
  const diff = await runGit(
    root,
    ["diff", "--no-renames", "--name-only", "-z", oid, headOid, "--", ...group.paths.map(literalPathspec)],
    signal,
  );
  if (!diff.ok || diff.exitCode !== 0) {
    return { kind: "incomplete", detail: `could not diff ${group.sha}..HEAD for this entry's paths` };
  }
  return { kind: "ok", changed: parseNulList(diff.stdout) };
}

/** Fixed-width worker pool that stops SCHEDULING once the deadline has passed. */
async function runPool<T>(
  items: readonly T[],
  width: number,
  pastDeadline: () => boolean,
  work: (item: T) => Promise<void>,
  onSkipped: (item: T) => void,
): Promise<boolean> {
  let next = 0;
  let deadlineHit = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      if (pastDeadline()) {
        deadlineHit = true;
        onSkipped(item);
        continue;
      }
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, Math.max(items.length, 1)) }, worker));
  return deadlineHit;
}

// --- the check ---

/**
 * Structural and freshness results for every entry handed in.
 *
 * `entries` is a parameter rather than something this function loads, so the
 * caller decides which document is being checked: the project's catalog, a
 * single entry about to be added, or a fixture. `state` supplies the ticket
 * and issue ids for item resolution and may be null when they are not being
 * checked.
 */
export async function checkCapabilities(
  root: string,
  entries: readonly Capability[],
  state: ProjectState | null = null,
  options: CheckOptions = {},
): Promise<CapabilityCheckReport> {
  const now = options.now ?? Date.now;
  const git = options.runGit ?? runGit;
  const start = now();
  const deadline = start + CHECK_DEADLINE_MS;
  const pastDeadline = (): boolean => now() >= deadline;

  const index = buildReferenceIndex(root, state, options.snapshot);
  const perEntry = new Map<string, CapabilityCheckResult[]>();
  for (const entry of entries) {
    const results = [...checkEntryPoints(root, entry), ...checkReferences(entry, index)];
    if (options.conflictedIds?.has(entry.id)) {
      results.push(result("capability_conflicted", "structural", "an unresolved merge conflict names this entry"));
    }
    if (options.problemIds?.has(entry.id)) {
      results.push(result("capability_invariant_problem", "structural", "this entry violates a catalog invariant"));
    }
    perEntry.set(entry.id, results);
  }

  let gitCalls = 0;
  const countCall = (): void => {
    gitCalls += 1;
  };
  const unchecked: string[] = [];
  let head: string | null = null;
  let deadlineHit = false;

  if (!options.skipFreshness && entries.length > 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_DEADLINE_MS);
    try {
      countCall();
      // A caller-supplied commit is resolved like HEAD is, so a bad oid is
      // "could not be read", never a diff against a string git rejects.
      // An option-shaped oid is refused outright rather than handed to git.
      const target = options.headOid === undefined ? "HEAD^{commit}" : options.headOid.startsWith("-") ? null : `${options.headOid}^{commit}`;
      const headOut = target === null ? null : await git(root, ["rev-parse", "--verify", target], controller.signal);
      head = headOut !== null && headOut.ok && headOut.exitCode === 0 ? headOut.stdout.trim() || null : null;

      const groups = groupByCheckpoint(entries);
      if (head === null) {
        for (const g of groups) {
          for (const entry of g.entries) {
            perEntry
              .get(entry.id)!
              .push(result("capability_check_incomplete", "incomplete", "HEAD could not be read, so freshness was not checked"));
            unchecked.push(entry.id);
          }
        }
      } else {
        const headOid = head;
        deadlineHit = await runPool(
          groups,
          CHECK_CONCURRENCY,
          pastDeadline,
          async (group) => {
            const outcome = await checkGroup(root, group, headOid, controller.signal, countCall, git);
            for (const entry of group.entries) {
              const results = perEntry.get(entry.id)!;
              if (outcome.kind === "unverifiable") {
                results.push(result("capability_unverifiable_checkpoint", "freshness", outcome.detail));
                continue;
              }
              if (outcome.kind === "incomplete") {
                results.push(result("capability_check_incomplete", "incomplete", outcome.detail));
                unchecked.push(entry.id);
                continue;
              }
              const touched = outcome.changed.filter((f) => entry.entryPoints.some((ep) => isPathWithin(ep, f)));
              if (touched.length > 0) {
                results.push(
                  result(
                    "capability_changed",
                    "freshness",
                    `${touched.length} file(s) under this entry's paths changed since ${group.sha}: ${touched.slice(0, 5).map((f) => sanitizeDisplayPath(f)).join(", ")}${touched.length > 5 ? ", ..." : ""}`,
                  ),
                );
              }
            }
          },
          (group) => {
            for (const entry of group.entries) {
              perEntry
                .get(entry.id)!
                .push(result("capability_check_timeout", "incomplete", "the check deadline passed before this entry was checked"));
              unchecked.push(entry.id);
            }
          },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const reported: CapabilityCheckEntry[] = entries.map((entry) => {
    const results = perEntry.get(entry.id) ?? [];
    const pending = hasPendingNote(entry);
    return {
      id: entry.id,
      storedStatus: entry.status,
      effectiveStatus: effectiveStatus(entry.status, results, pending),
      results,
      pendingNote: pending ? entry.pendingNote! : null,
    };
  });

  return {
    entries: reported,
    head,
    unchecked,
    gitCalls,
    deadlineHit,
    ...(options.snapshot !== undefined && {
      filesystemChecks: "working-tree" as const,
      ...(options.snapshot.commit !== null && { snapshotCommit: options.snapshot.commit }),
    }),
  };
}

/** True when the entry may be stamped: freshness may be dirty, structure may not. */
export function isStampable(entry: CapabilityCheckEntry): boolean {
  return !entry.results.some((r) => r.cls === "structural" || r.cls === "incomplete");
}

/** Only these codes are cleared by re-stamping. */
export function isFreshnessCode(code: CapabilityCheckCode): boolean {
  return FRESHNESS_CODES.has(code);
}

// --- match ---

export type MatchReasonKind = "path" | "title" | "phase";

export interface MatchReason {
  readonly kind: MatchReasonKind;
  /** Human-readable, already safe to print, sanitized as `CapabilityCheckResult.detail` is. */
  readonly detail: string;
}

export interface CapabilityMatch {
  /** The stored entry, RAW: a consumer acts on these paths, so escaping is the renderer's job. */
  readonly capability: Capability;
  readonly reasons: readonly MatchReason[];
}

export interface CapabilityMatchResult {
  readonly matches: readonly CapabilityMatch[];
  /** What the caller passed, RAW, for the same reason as `CapabilityMatch.capability`. */
  readonly searched: { readonly paths: readonly string[]; readonly titleWords: readonly string[]; readonly phaseId: string | null };
  readonly inventorySize: number;
  readonly excluded: readonly { readonly id: string; readonly reason: string }[];
  readonly bounded: "inventory only";
}

export interface MatchCriteria {
  readonly paths?: readonly string[];
  readonly title?: string;
  readonly phaseId?: string;
}

/**
 * A query path is held to the SAME rules as an entry point (`ENTRY_POINT_RULES`
 * in the model), run through the same normalizer; only the wording differs.
 * Every refused form is one that could never match honestly: an absolute or
 * backslash path relates to no repo-relative entry and returned an empty match
 * in silence, the root relates to everything and matched nothing, and a `..`
 * path matched the wrong entry. It is refused rather than resolved lexically
 * because collapsing `a/link/../b` to `a/b` is only correct when `link` is not
 * a symlink, which is exactly why the normalizer keeps `..`: the form has more
 * than one possible meaning, and ambiguous forms are refused.
 */
const QUERY_PATH_MESSAGES: Readonly<Record<EntryPointRule, (q: string) => string>> = {
  root: (q) =>
    `path ${q} names the repo root, which every entry sits under, so it cannot narrow a match: name a file or directory beneath the root`,
  absolute: (q) =>
    `path ${q} is absolute: pass it relative to the repository root, the form git prints (src/core/x.ts, not /home/me/project/src/core/x.ts)`,
  parent: (q) =>
    `path ${q} contains a \`..\` segment, which the text alone cannot resolve (a/link/../b is not a/b when link is a symlink): pass the path as git prints it`,
  backslash: (q) => `path ${q} uses backslashes: pass it with forward slashes, the form git prints`,
};

/**
 * The query as a refusal names it. It is the caller's own input, but a refusal
 * is printed like any detail, so it takes the same reversible form a path in a
 * detail does: the `JSON.stringify` this replaced escaped C0 controls and left
 * C1, bidi and line-separator characters raw. An empty query is named, because
 * the reversible form of "" is a gap in the sentence; no refused form can be a
 * path literally named `(empty)`, since that name breaks none of the rules.
 */
function refusedQuery(q: string): string {
  return q === "" ? "(empty)" : sanitizeDisplayPath(q);
}

/** Why `match` refuses a query path, or null when the entry-point rules accept it. */
export function queryPathRefusal(q: string): string | null {
  const [rule] = entryPointViolations(normalizeEntryPoint(q));
  return rule === undefined ? null : QUERY_PATH_MESSAGES[rule](refusedQuery(q));
}

/**
 * Segment-aware, both directions: a query path matches an entry point when
 * they are equal, when the query contains the entry point, or when the entry
 * point contains the query. `src/core-extra` never matches `src/core`, because
 * containment is tested on a `/` boundary rather than as a string prefix.
 *
 * Nothing here touches the filesystem, and it does not need to: a FILE entry
 * point can only ever match itself or a directory above it, because no query
 * path can legitimately live underneath a file. Sibling files never match for
 * the same reason. Keeping it pure means `match` gives the same answer for a
 * path that has since been deleted, which is what the freshness check is for.
 */
function pathReasons(entry: Capability, paths: readonly string[]): MatchReason[] {
  const out: MatchReason[] = [];
  for (const q of paths) {
    // The entry side was normalized by the schema; the query side goes through
    // the same function, so `./src/core/x.ts` relates to `src/core` exactly as
    // `src/core/x.ts` does.
    const query = normalizeEntryPoint(q);
    for (const ep of entry.entryPoints) {
      if (query === ep) {
        out.push({ kind: "path", detail: `${sanitizeDisplayPath(q)} is the entry point ${sanitizeDisplayPath(ep)}` });
      } else if (isPathWithin(ep, query)) {
        out.push({ kind: "path", detail: `${sanitizeDisplayPath(q)} is under the entry point ${sanitizeDisplayPath(ep)}` });
      } else if (isPathWithin(query, ep)) {
        out.push({ kind: "path", detail: `${sanitizeDisplayPath(q)} contains the entry point ${sanitizeDisplayPath(ep)}` });
      }
    }
  }
  return out;
}

function titleReasons(entry: Capability, words: readonly string[]): MatchReason[] {
  if (words.length === 0) return [];
  const haystack = new Set(titleWords(`${entry.name} ${entry.summary}`));
  const hits = words.filter((w) => haystack.has(w));
  return hits.length === 0 ? [] : [{ kind: "title", detail: `title words matched: ${hits.join(", ")}` }];
}

function phaseReasons(entry: Capability, phaseItemIds: ReadonlySet<string> | null, phaseId: string | null): MatchReason[] {
  if (phaseItemIds === null || phaseId === null) return [];
  const hits = (entry.items ?? []).filter((id) => phaseItemIds.has(id));
  return hits.length === 0 ? [] : [{ kind: "phase", detail: `phase ${sanitizeDisplayText(phaseId)} includes ${hits.join(", ")}` }];
}

function phaseItemIdsFor(state: ProjectState | null, phaseId: string): Set<string> {
  const ids = new Set<string>();
  for (const t of state?.tickets ?? []) {
    if (t.phase !== phaseId) continue;
    ids.add(t.id);
    const display = (t as { displayId?: string | null }).displayId;
    if (typeof display === "string" && display.length > 0) ids.add(display);
  }
  for (const i of state?.issues ?? []) {
    if ((i as { phase?: string | null }).phase !== phaseId) continue;
    ids.add(i.id);
    const display = (i as { displayId?: string | null }).displayId;
    if (typeof display === "string" && display.length > 0) ids.add(display);
  }
  return ids;
}

/**
 * Criteria combine as a UNION, and every reason an entry matched is reported
 * rather than the first one: a caller deciding whether to trust a match needs
 * to know it came from a title word and not from a path.
 *
 * `excludedIds` are entries the caller has already determined are not safe to
 * offer (conflicted or invariant-violating). They are counted in
 * `inventorySize` and listed in `excluded`, never silently dropped, so the
 * disclosure stays honest about how much of the inventory was searchable.
 */
export function matchCapabilities(
  entries: readonly Capability[],
  criteria: MatchCriteria,
  state: ProjectState | null = null,
  excludedIds: ReadonlyMap<string, string> = new Map(),
): CapabilityMatchResult {
  const paths = criteria.paths ?? [];
  for (const q of paths) {
    const refusal = queryPathRefusal(q);
    // Handlers refuse these before calling in (`handleCapabilityMatch`). One
    // reaching here means a handler skipped that, which is a bug, so it throws
    // rather than returning no match: a quiet empty result would reintroduce
    // the silent wrong answer the handler check exists to prevent.
    if (refusal !== null) throw new Error(`matchCapabilities received an unvalidated query: ${refusal}`);
  }
  const words = criteria.title ? titleWords(criteria.title) : [];
  const phaseId = criteria.phaseId ?? null;
  const phaseItemIds = phaseId === null ? null : phaseItemIdsFor(state, phaseId);

  const matches: CapabilityMatch[] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const entry of entries) {
    const excludedReason = excludedIds.get(entry.id);
    if (excludedReason !== undefined) {
      excluded.push({ id: entry.id, reason: excludedReason });
      continue;
    }
    const reasons = [
      ...pathReasons(entry, paths),
      ...titleReasons(entry, words),
      ...phaseReasons(entry, phaseItemIds, phaseId),
    ];
    if (reasons.length > 0) matches.push({ capability: entry, reasons });
  }

  return {
    matches,
    searched: { paths, titleWords: words, phaseId },
    inventorySize: entries.length,
    excluded,
    bounded: "inventory only",
  };
}

/** The sentence every renderer prints beside a match result (C-C). */
export function matchDisclosure(res: CapabilityMatchResult): string {
  const criteria: string[] = [];
  if (res.searched.paths.length > 0) criteria.push(`path (${res.searched.paths.map((p) => sanitizeDisplayPath(p)).join(", ")})`);
  if (res.searched.titleWords.length > 0) criteria.push(`title words (${res.searched.titleWords.join(", ")})`);
  if (res.searched.phaseId !== null) criteria.push(`phase ${sanitizeDisplayText(res.searched.phaseId)}`);
  const by = criteria.length > 0 ? ` by ${criteria.join(" and ")}` : "";
  const skipped = res.excluded.length > 0 ? `; ${res.excluded.length} entry(ies) excluded as unresolved` : "";
  return (
    `searched ${res.inventorySize} inventory entries${by}${skipped}; ` +
    `no match is not evidence that no implementation exists`
  );
}
