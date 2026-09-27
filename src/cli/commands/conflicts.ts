import { resolve } from "node:path";
import { hasConflicts, CATALOG_CONFLICT_IDS, type CatalogConflictSource, type CatalogConflictType } from "../../core/conflicts.js";
import { CatalogLoadError } from "../../core/catalog.js";
import { glossaryCatalog } from "../../core/glossary.js";
import { capabilityCatalog } from "./capability.js";
import { resolveConflicts, isEntityLevel, fieldName, type ResolveOptions, type ResolveResult } from "../../core/resolve.js";
import { resolveDocConflicts } from "../../core/resolve-doc.js";
import { loadArrangementsSafe, writeArrangementUnlocked } from "../../core/arrangement-loader.js";
import { displayIdOf } from "../../core/resolver.js";
import type { ProjectState } from "../../core/project-state.js";
import type { LoadWarning } from "../../core/errors.js";
import type { ConflictEntry } from "../../models/types.js";
import type { Arrangement } from "../../models/arrangement.js";
import type { Ruling } from "../../models/ruling.js";
import { loadRulingsSafe, writeRulingUnlocked } from "../../core/ruling-loader.js";
import type { CommandResult } from "../types.js";
import { CliValidationError } from "../helpers.js";
import { sanitizeDisplayText, MAX_PROSE_LENGTH } from "../../core/display-text.js";
import { catalogOnlyFlags, handleCatalogResolve, type CatalogResolveInput } from "./resolve-catalog.js";

export type ConflictTarget =
  | { kind: "config" }
  | { kind: "roadmap" }
  | { kind: "ticket" | "issue" | "note" | "lesson"; entity: Record<string, unknown> }
  | { kind: "arrangement"; entity: Arrangement }
  | { kind: "ruling"; entity: Ruling }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "missing" };

/**
 * Unified conflict-target lookup: config/roadmap by name (both the report ids
 * "config.json"/"roadmap.json" and the short aliases), entities through the
 * display-ID-aware resolvers like every other command, arrangements by direct
 * `id` equality (no display-ID concept exists for them, per Decision 1).
 */
export function resolveConflictTarget(
  state: ProjectState,
  id: string,
  arrangements: readonly Arrangement[] = [],
  rulings: readonly Ruling[] = [],
): ConflictTarget {
  if (id === "config" || id === "config.json") return { kind: "config" };
  if (id === "roadmap" || id === "roadmap.json") return { kind: "roadmap" };

  const chains = [
    { kind: "ticket" as const, result: state.resolveTicketRef(id) },
    { kind: "issue" as const, result: state.resolveIssueRef(id) },
    { kind: "note" as const, result: state.resolveNoteRef(id) },
    { kind: "lesson" as const, result: state.resolveLessonRef(id) },
  ];
  for (const { kind, result } of chains) {
    if (result.kind === "found") return { kind, entity: result.item as Record<string, unknown> };
  }

  const arrangement = arrangements.find((a) => a.id === id);
  if (arrangement) return { kind: "arrangement", entity: arrangement };
  // T-522: rulings by direct id, same footing as arrangements.
  const ruling = rulings.find((r) => r.id === id);
  if (ruling) return { kind: "ruling", entity: ruling };

  for (const { result } of chains) {
    if (result.kind === "ambiguous") {
      return { kind: "ambiguous", matches: result.matches.map((m) => (m as { id: string }).id) };
    }
  }
  return { kind: "missing" };
}

/**
 * T-529: a catalog file named as a conflict target, by its report id or its
 * short name. Checked BEFORE `resolveConflictTarget`: no ledger id can take
 * one of these four forms, and keeping catalogs out of that lookup keeps them
 * out of every entity path that consumes it.
 */
export function catalogTargetOf(id: string): CatalogConflictType | null {
  if (id === "capabilities" || id === CATALOG_CONFLICT_IDS.capabilities) return "capabilities";
  if (id === "glossary" || id === CATALOG_CONFLICT_IDS.glossary) return "glossary";
  return null;
}

/**
 * Reads one catalog's own `_conflicts` for the report. A catalog that cannot
 * be read is reported as a warning, never thrown: one broken file must not
 * hide every other conflict, and it must not read as clean either.
 */
function loadCatalogConflicts(root: string, type: CatalogConflictType): { source?: CatalogConflictSource; warning?: string } {
  const catalog = type === "capabilities" ? capabilityCatalog : glossaryCatalog;
  try {
    const { doc } = catalog.load(root);
    return { source: { type, _conflicts: (doc as { _conflicts?: unknown })._conflicts } };
  } catch (err: unknown) {
    if (err instanceof CatalogLoadError) return { warning: err.message };
    throw err;
  }
}

function loadCatalogConflictSources(root: string): { catalogs: CatalogConflictSource[]; warnings: string[] } {
  const catalogs: CatalogConflictSource[] = [];
  const warnings: string[] = [];
  for (const type of ["capabilities", "glossary"] as const) {
    const { source, warning } = loadCatalogConflicts(root, type);
    if (source) catalogs.push(source);
    if (warning) warnings.push(warning);
  }
  return { catalogs, warnings };
}

/**
 * T-529: every catalog line printed to a terminal is built from a file a merge
 * wrote from someone's branch (ids, paths, group names, payloads, and the
 * parse errors that quote them), so each one is sanitized whole. No length cap
 * on a record line: a truncated payload would misstate what the resolve takes.
 */
function catalogDisplayLine(line: string): string {
  return sanitizeDisplayText(line, Number.MAX_SAFE_INTEGER);
}

function catalogWarningsSection(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return [
    "",
    `Catalog scan incomplete: ${warnings.map((w) => sanitizeDisplayText(w, MAX_PROSE_LENGTH)).join("; ")}. An unreadable catalog cannot be confirmed clean. ` +
    "Run `storybloq validate` for details.",
  ];
}

const DAMAGE_WARNING_TYPES = new Set(["schema_error", "parse_error"]);

function diagnosticsSection(warnings: readonly LoadWarning[]): string[] {
  const damaged = warnings.filter((w) => DAMAGE_WARNING_TYPES.has(w.type));
  if (damaged.length === 0) return [];
  const paths = damaged.map((w) => w.file);
  return [
    "",
    `${damaged.length} file(s) failed to load and may contain merge damage: ${paths.join(", ")}. ` +
    `Restore with git (e.g. git checkout --theirs -- ${paths[0]}) or hand-edit, then rerun.`,
  ];
}

function arrangementWarningsSection(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return [
    "",
    `Arrangement scan incomplete: ${warnings.join("; ")}. A damaged arrangement is hidden from this ` +
    "list and cannot be confirmed clean. Run `storybloq validate` for details.",
  ];
}

function rulingWarningsSection(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return [
    "",
    `Ruling scan incomplete: ${warnings.join("; ")}. A damaged ruling is hidden from this ` +
    "list and cannot be confirmed clean. Run `storybloq validate` for details.",
  ];
}

/** T-478 / T-522: a not-found under an incomplete scan names the scan, not a flat miss. */
function notFoundMessage(id: string, arrangementWarnings: readonly string[], rulingWarnings: readonly string[]): string {
  const incomplete: string[] = [];
  if (arrangementWarnings.length > 0) incomplete.push(`Arrangement scan was incomplete (${arrangementWarnings.join("; ")})`);
  if (rulingWarnings.length > 0) incomplete.push(`Ruling scan was incomplete (${rulingWarnings.join("; ")})`);
  if (incomplete.length === 0) return `Entity ${id} not found.`;
  return `Entity ${id} not found. ${incomplete.join(". ")}, so ` +
    `this id may be one of the unreadable entries. Run \`storybloq validate\` for details.`;
}

export async function handleConflictsList(
  root: string,
  format: "md" | "json",
): Promise<CommandResult> {
  const { loadProject } = await import("../../core/project-loader.js");
  const { state, warnings } = await loadProject(resolve(root));
  const arrangementScan = loadArrangementsSafe(root);
  const rulingScan = loadRulingsSafe(root);
  const catalogScan = loadCatalogConflictSources(root);
  const report = hasConflicts(state, arrangementScan.arrangements, rulingScan.rulings, catalogScan.catalogs);

  if (format === "json") {
    return {
      output: JSON.stringify(
        {
          ok: true,
          data: report,
          arrangementWarnings: arrangementScan.warnings,
          rulingWarnings: rulingScan.warnings,
          catalogWarnings: catalogScan.warnings,
        },
        null,
        2,
      ),
    };
  }

  if (!report.hasConflicts) {
    return {
      output: [
        "No conflicts found.",
        ...diagnosticsSection(warnings),
        ...arrangementWarningsSection(arrangementScan.warnings),
        ...rulingWarningsSection(rulingScan.warnings),
        ...catalogWarningsSection(catalogScan.warnings),
      ].join("\n"),
    };
  }

  const lines = ["## Conflicts", "", "| Type | ID | Fields |", "|------|----|--------|"];
  for (const item of report.items) {
    let shownId = item.id;
    if (item.type === "ticket" || item.type === "issue" || item.type === "note" || item.type === "lesson") {
      const target = resolveConflictTarget(state, item.id);
      if ("entity" in target) shownId = displayIdOf(target.entity as { id: string; displayId?: string | null });
    }
    lines.push(`| ${item.type} | ${shownId} | ${item.conflictCount} |`);
  }
  lines.push(
    "",
    "Run `storybloq conflicts show <id>`, then `storybloq resolve <id> --use ours|theirs`. " +
    "For config.json/roadmap.json use `storybloq resolve config` / `storybloq resolve roadmap`.",
  );
  if (report.items.some((i) => i.type === "capabilities" || i.type === "glossary")) {
    lines.push(
      "For capabilities.json/glossary.json run `storybloq conflicts show <file>`; " +
      "ordinary writes to a conflicted catalog are refused until it is resolved.",
    );
  }
  lines.push(...diagnosticsSection(warnings));
  lines.push(...arrangementWarningsSection(arrangementScan.warnings));
  lines.push(...rulingWarningsSection(rulingScan.warnings));
  lines.push(...catalogWarningsSection(catalogScan.warnings));
  return { output: lines.join("\n") };
}

function isDeletedSnapshot(obj: Record<string, unknown>): boolean {
  return obj.lifecycle === "deleted" || obj.deletedAt != null;
}

function sideSummary(label: string, value: unknown): string {
  if (typeof value === "string") {
    // JSON.stringify neutralizes ESC/OSC/BEL and other control bytes in this
    // UNTRUSTED teammate-authored string; a raw interpolation would emit
    // terminal escape sequences to the victim.
    return `- ${label}: ${JSON.stringify(value)} (snapshots unavailable, pre-1.5.0)`;
  }
  if (value === null || value === undefined) {
    return `- ${label}: (absent)`;
  }
  const snap = value as Record<string, unknown>;
  if (isDeletedSnapshot(snap)) {
    // deletedBy/deletedAt come from an untrusted snapshot too; JSON.stringify
    // them (same neutralization as the string and edited branches) so crafted
    // control bytes cannot reach the terminal.
    return `- ${label}: deleted (tombstone by ${JSON.stringify(String(snap.deletedBy ?? "unknown"))} at ${JSON.stringify(String(snap.deletedAt ?? "unknown"))})`;
  }
  return `- ${label}: edited (title: ${JSON.stringify(snap.title ?? snap.name ?? snap.id ?? "?")})`;
}

function renderConflicts(displayId: string, conflicts: Array<Record<string, unknown>>): string {
  const lines = [`## Conflicts for ${displayId}`, ""];
  for (const c of conflicts) {
    if (isEntityLevel(c as ConflictEntry)) {
      lines.push(`### (entire entity) [${String(c.kind)}]`);
      lines.push(sideSummary("Base", c.base));
      lines.push(sideSummary("Ours", c.ours));
      lines.push(sideSummary("Theirs", c.theirs));
      lines.push(`Resolve with: storybloq resolve ${displayId} --use ours|theirs (whole entity)`);
      lines.push("");
      continue;
    }
    const group = c.group ? ` (group: ${c.group})` : "";
    lines.push(`### ${c.fieldPath} [${c.kind}]${group}`);
    lines.push(`- Base:   ${JSON.stringify(c.base)}`);
    lines.push(`- Ours:   ${JSON.stringify(c.ours)}`);
    lines.push(`- Theirs: ${JSON.stringify(c.theirs)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * T-529: a catalog's records. A record for one entry is headed by that entry's
 * id, because the index in its `fieldPath` is where the entry sat when the
 * merge ran and may no longer be where it sits. `invariant` records are
 * numbered 1, 2, ... in file order; that ordinal is what `resolve --invariant
 * <n>` takes, and it renumbers after each resolution.
 */
function renderCatalogConflicts(label: string, conflicts: Array<Record<string, unknown>>): string {
  const lines = [`## Conflicts for ${label}`, ""];
  let invariant = 0;
  for (const c of conflicts) {
    if (c.kind === "invariant") {
      invariant += 1;
      const ids = Array.isArray(c.entityIds) ? c.entityIds.map((v) => JSON.stringify(String(v))).join(", ") : "(none)";
      lines.push(`### Invariant ${invariant}: ${String(c.rule)} ${JSON.stringify(String(c.key))} [invariant]`);
      lines.push(`- Entries: ${ids}`);
      lines.push("");
      continue;
    }
    if (typeof c.entityId === "string") {
      const inside = String(c.fieldPath).replace(/^\/[^/]*\/[^/]*/, "");
      const group = c.group ? ` (group: ${String(c.group)})` : "";
      lines.push(`### ${JSON.stringify(c.entityId)}${inside === "" ? "" : ` ${inside}`} [${String(c.kind)}]${group}`);
      lines.push(`- Base:   ${JSON.stringify(c.base)}`);
      lines.push(`- Ours:   ${JSON.stringify(c.ours)}`);
      lines.push(`- Theirs: ${JSON.stringify(c.theirs)}`);
      lines.push("");
      continue;
    }
    lines.push(...renderConflicts(label, [c]).split("\n").slice(2));
  }
  return lines.map(catalogDisplayLine).join("\n");
}

async function showCatalogConflicts(root: string, type: CatalogConflictType, format: "md" | "json"): Promise<CommandResult> {
  const label = CATALOG_CONFLICT_IDS[type];
  const { source, warning } = loadCatalogConflicts(root, type);
  if (warning !== undefined) {
    return {
      output: format === "json" ? JSON.stringify({ ok: false, error: warning }, null, 2) : sanitizeDisplayText(warning, MAX_PROSE_LENGTH),
      exitCode: 1,
    };
  }
  const conflicts = Array.isArray(source?._conflicts) ? (source._conflicts as Array<Record<string, unknown>>) : [];
  if (conflicts.length === 0) {
    return {
      output:
        format === "json"
          ? JSON.stringify({ ok: true, data: { id: label, conflicts: [] } }, null, 2)
          : `${label} has no conflicts.`,
    };
  }
  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: { id: label, conflicts } }, null, 2) };
  }
  return { output: renderCatalogConflicts(label, conflicts) };
}

export async function handleConflictsShow(
  id: string,
  root: string,
  format: "md" | "json",
): Promise<CommandResult> {
  const catalogTarget = catalogTargetOf(id);
  if (catalogTarget !== null) return showCatalogConflicts(root, catalogTarget, format);

  const { loadProject } = await import("../../core/project-loader.js");
  const { state } = await loadProject(resolve(root));
  const arrangementScan = loadArrangementsSafe(root);
  const rulingScan = loadRulingsSafe(root);

  // ISS-910: these branches must honor `format`. This command documents an
  // {"ok", ...} JSON contract in its --help, and a routine lookup failure
  // answering in prose hands an automated caller non-JSON on stdout -- the
  // exact parser breakage this issue exists to close. Failure shape matches
  // the sibling handleResolve: {ok: false, error}.
  const target = resolveConflictTarget(state, id, arrangementScan.arrangements, rulingScan.rulings);
  if (target.kind === "missing") {
    // T-478: an incomplete arrangement scan means this id might be one of
    // the unreadable entries, not genuinely nonexistent -- repair-oriented
    // message instead of a flat not-found that could mislead.
    const message = notFoundMessage(id, arrangementScan.warnings, rulingScan.warnings);
    return {
      output: format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message,
      exitCode: 1,
    };
  }
  if (target.kind === "ambiguous") {
    const message = `Ref "${id}" is ambiguous (matches: ${target.matches.join(", ")})`;
    return {
      output: format === "json" ? JSON.stringify({ ok: false, error: message }, null, 2) : message,
      exitCode: 1,
    };
  }

  let holder: Record<string, unknown>;
  let label: string;
  if (target.kind === "config") {
    holder = state.config as Record<string, unknown>;
    label = "config.json";
  } else if (target.kind === "roadmap") {
    holder = state.roadmap as Record<string, unknown>;
    label = "roadmap.json";
  } else if (target.kind === "arrangement" || target.kind === "ruling") {
    holder = target.entity as unknown as Record<string, unknown>;
    label = target.entity.id;
  } else {
    holder = target.entity;
    label = displayIdOf(target.entity as { id: string; displayId?: string | null });
  }

  const conflicts = holder._conflicts as Array<Record<string, unknown>> | undefined;
  if (!conflicts || conflicts.length === 0) {
    // A found entity with nothing to report is SUCCESS with an empty list,
    // not an error -- and under json it is the same shape as any other
    // success, so a caller parses one shape for both.
    return {
      output:
        format === "json"
          ? JSON.stringify({ ok: true, data: { id: label, conflicts: [] } }, null, 2)
          : `${label} has no conflicts.`,
    };
  }

  if (format === "json") {
    return { output: JSON.stringify({ ok: true, data: { id: label, conflicts } }, null, 2) };
  }

  return { output: renderConflicts(label, conflicts) };
}

const CHECKPOINT_GROUP_FIELDS = new Set(["ownerCheckpoint", "status", "completedDate", "lifecycle"]);

/**
 * T-537: a resolved ticket write. A resolution that settles a checkpoint's
 * status group (or the whole entity) goes through the checkpoint lifecycle,
 * which checks consistency and advances the generation; a dependent's
 * selected evidence is adopted as that side had it. Everything else is the
 * ordinary write.
 */
async function writeResolvedTicket(
  prior: Record<string, unknown>,
  resolved: Record<string, unknown>,
  conflicts: readonly ConflictEntry[],
  result: ResolveResult,
  options: ResolveOptions,
  root: string,
): Promise<void> {
  const { writeTicketUnlocked } = await import("../../core/project-loader.js");
  const { hasOwnerCheckpoint } = await import("../../core/owner-checkpoint.js");
  const touched = new Set(result.resolved);
  const named = (c: ConflictEntry): string => (isEntityLevel(c) ? "_entity" : fieldName(c));
  const settled = conflicts.filter((c) => {
    const name = named(c);
    return touched.has(name) && (name === "_entity" || CHECKPOINT_GROUP_FIELDS.has(name) || name === "checkpointEvidence");
  });
  const sideHas = (c: ConflictEntry, v: unknown): boolean => {
    if (named(c) === "ownerCheckpoint") return v !== undefined && v !== null;
    return v !== null && typeof v === "object" && hasOwnerCheckpoint(v);
  };
  const sidesHadCheckpoint = settled.some((c) => sideHas(c, c.ours) || sideHas(c, c.theirs) || sideHas(c, c.base));
  const checkpointSettled = settled.some((c) => named(c) !== "checkpointEvidence");
  const evidenceOf = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as Record<string, unknown>).checkpointEvidence : undefined);
  const evidenceChoices = settled.flatMap((c) =>
    named(c) === "checkpointEvidence" ? [c.ours, c.theirs] : named(c) === "_entity" ? [evidenceOf(c.ours), evidenceOf(c.theirs)] : []);
  if (checkpointSettled && (sidesHadCheckpoint || hasOwnerCheckpoint(prior) || hasOwnerCheckpoint(resolved))) {
    // The discarded side is the one not selected; a --value resolution keeps both.
    const discardedOf = (c: ConflictEntry): unknown =>
      options.use === "ours" ? c.theirs : options.use === "theirs" ? c.ours : { ours: c.ours, theirs: c.theirs };
    const entry = settled.find((c) => named(c) === "_entity")
      ?? settled.find((c) => named(c) === "ownerCheckpoint")
      ?? settled[0]!;
    const { settleCheckpointConflict } = await import("../../core/checkpoint-lifecycle.js");
    await settleCheckpointConflict(prior, resolved, {
      discarded: discardedOf(entry),
      snapshots: settled.flatMap((c) => [c.base, c.ours, c.theirs]),
      evidenceChoices,
      sidesHadCheckpoint,
      actor: options.actor ?? "unknown",
    }, root);
    return;
  }
  if (settled.length > 0) {
    // A dependent: the selected side's evidence (already applied) is adopted as
    // that side had it. Only a side's: evidence a --value brings that neither
    // side had never gets the conflict's authority.
    const { sameValue } = await import("../../core/checkpoint-guard.js");
    if (!sameValue(prior.checkpointEvidence, resolved.checkpointEvidence)
      && !evidenceChoices.some((e) => sameValue(e, resolved.checkpointEvidence))) {
      const label = typeof resolved.displayId === "string" ? resolved.displayId : String(resolved.id);
      throw new CliValidationError(
        "conflict",
        `Cannot resolve ${label} this way: the selected checkpointEvidence is not either side's; evidence is adopted as a side had it, never edited.`,
      );
    }
    const { adoptConflictEvidence } = await import("../../core/checkpoint-evidence.js");
    await adoptConflictEvidence(resolved as never, resolved, root);
    return;
  }
  await writeTicketUnlocked(resolved as never, root);
}

export async function handleResolve(
  id: string,
  root: string,
  options: ResolveOptions & Omit<CatalogResolveInput, "field" | "use" | "value"> & { format?: "md" | "json" },
): Promise<CommandResult> {
  const format = options.format ?? "md";
  // T-529: a catalog is resolved by its own handler, BEFORE this function's
  // lock: `mutateForRepair` takes the conflict-resolution lock itself, and
  // that lock is not re-entrant.
  const catalogTarget = catalogTargetOf(id);
  if (catalogTarget !== null) return handleCatalogResolve(catalogTarget, root, options);
  const catalogFlags = catalogOnlyFlags(options);
  if (catalogFlags.length > 0) {
    throw new Error(
      `${catalogFlags.join(", ")} ${catalogFlags.length === 1 ? "applies" : "apply"} only to a catalog ` +
      `(capabilities or glossary), not to ${JSON.stringify(id)}.`,
    );
  }
  const {
    withConflictResolutionLock,
    writeTicketUnlocked, writeIssueUnlocked, writeNoteUnlocked, writeLessonUnlocked,
    writeConfigUnlocked, writeRoadmapUnlocked,
    resolveActor,
  } = await import("../../core/project-loader.js");

  const actor = await resolveActor(root, options.actor);

  let output = "";
  let exitCode: 0 | 1 = 0;

  await withConflictResolutionLock(root, async ({ state }) => {
    // T-478: loaded INSIDE the lock, not before -- loading before the lock
    // would let a resolve decision be computed against an arrangement
    // snapshot that a concurrent write could invalidate before the lock is
    // actually held (same TOCTOU class closed elsewhere in this plan).
    const arrangementScan = loadArrangementsSafe(root);
    const rulingScan = loadRulingsSafe(root);
    const target = resolveConflictTarget(state, id, arrangementScan.arrangements, rulingScan.rulings);

    if (target.kind === "missing") {
      const message = notFoundMessage(id, arrangementScan.warnings, rulingScan.warnings);
      output = format === "json"
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : message;
      exitCode = 1;
      return;
    }
    if (target.kind === "ambiguous") {
      const message = `Ref "${id}" is ambiguous (matches: ${target.matches.join(", ")})`;
      output = format === "json"
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : message;
      exitCode = 1;
      return;
    }

    const resolveOptions: ResolveOptions = { ...options, actor };
    let result: ResolveResult;
    let label: string;

    if (target.kind === "config") {
      const mutable = { ...(state.config as Record<string, unknown>) };
      result = resolveDocConflicts(mutable, resolveOptions);
      try {
        await writeConfigUnlocked(mutable as never, root);
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The chosen side leaves config.json invalid; pick the other side or supply --value.`,
        );
      }
      label = "config.json";
    } else if (target.kind === "roadmap") {
      const mutable = { ...(state.roadmap as Record<string, unknown>) };
      result = resolveDocConflicts(mutable, resolveOptions);
      try {
        await writeRoadmapUnlocked(mutable as never, root);
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The chosen side leaves roadmap.json invalid; pick the other side or supply --value.`,
        );
      }
      label = "roadmap.json";
    } else if (target.kind === "arrangement") {
      const mutable = { ...target.entity };
      result = resolveConflicts(mutable, resolveOptions);
      await writeArrangementUnlocked(mutable as never, root);
      label = target.entity.id;
    } else if (target.kind === "ruling") {
      // T-522: `resolve --use` swaps the whole lifecycle group; the written
      // record is one coherent side and classifies on its own evidence.
      const mutable = { ...target.entity } as Record<string, unknown>;
      result = resolveConflicts(mutable, resolveOptions);
      await writeRulingUnlocked(JSON.parse(JSON.stringify(mutable)) as never, root);
      label = target.entity.id;
    } else {
      const mutable = { ...target.entity };
      const before = ((target.entity as Record<string, unknown>)._conflicts ?? []) as ConflictEntry[];
      result = resolveConflicts(mutable, resolveOptions);
      if (target.kind === "ticket") await writeResolvedTicket(target.entity as Record<string, unknown>, mutable as Record<string, unknown>, before, result, resolveOptions, root);
      else if (target.kind === "issue") await writeIssueUnlocked(mutable as never, root);
      else if (target.kind === "note") await writeNoteUnlocked(mutable as never, root);
      else await writeLessonUnlocked(mutable as never, root);
      label = displayIdOf(target.entity as { id: string; displayId?: string | null });
    }

    if (format === "json") {
      output = JSON.stringify({ ok: true, data: result }, null, 2);
    } else {
      const lines = [`Resolved ${result.resolved.length} conflict(s) on ${label}.`];
      lines.push(...result.messages);
      lines.push(...result.warnings);
      if (result.remaining > 0) {
        lines.push(`${result.remaining} conflict(s) remaining.`);
      } else {
        lines.push("All conflicts resolved.");
      }
      output = lines.join("\n");
    }
  });

  return exitCode === 0 ? { output } : { output, exitCode };
}
