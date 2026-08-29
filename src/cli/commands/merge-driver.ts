import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ZodTypeAny } from "zod";
import {
  threeWayMerge, mergeConfig, mergeRoadmap,
  stripConflicts, entitySnapshot, deepEqual,
  type MergeResult,
} from "../../core/merge-driver.js";
import { carryForward } from "../../core/conflict-lifecycle.js";
import type { EntityType } from "../../core/field-classification.js";
import { TicketSchema } from "../../models/ticket.js";
import { IssueSchema } from "../../models/issue.js";
import { NoteSchema } from "../../models/note.js";
import { LessonSchema } from "../../models/lesson.js";
import { ConfigSchema } from "../../models/config.js";
import { RoadmapSchema } from "../../models/roadmap.js";
import { ConflictEntrySchema } from "../../models/types.js";
import { ArrangementSchema } from "../../models/arrangement.js";

function entityTypeFromPath(pathname: string): EntityType | null {
  const dir = basename(dirname(pathname));
  switch (dir) {
    case "tickets": return "ticket";
    case "issues": return "issue";
    case "notes": return "note";
    case "lessons": return "lesson";
    case "arrangements": return "arrangement";
    default: return null;
  }
}

export type MergeStrategy =
  | { kind: "entity"; entityType: EntityType }
  | { kind: "config" }
  | { kind: "roadmap" };

function strategyFromPath(pathname: string): MergeStrategy | null {
  const file = basename(pathname);
  if (file === "config.json") return { kind: "config" };
  if (file === "roadmap.json") return { kind: "roadmap" };
  const entityType = entityTypeFromPath(pathname);
  if (entityType) return { kind: "entity", entityType };
  return null;
}

/** The EXACT schemas the loader enforces -- gate-pass must equal loadability. */
export function schemaFor(strategy: MergeStrategy): ZodTypeAny {
  if (strategy.kind === "config") return ConfigSchema;
  if (strategy.kind === "roadmap") return RoadmapSchema;
  switch (strategy.entityType) {
    case "ticket": return TicketSchema;
    case "issue": return IssueSchema;
    case "note": return NoteSchema;
    case "lesson": return LessonSchema;
    case "arrangement": return ArrangementSchema;
  }
}

function diag(message: string): void {
  // Git surfaces driver stderr to the user.
  process.stderr.write(`storybloq merge-driver: ${message}\n`);
}

/**
 * Output validation gate (ISS-747 backstop): the driver must never write a
 * file the loader would skip.
 *
 * 1. Validate the FULL merged output with the loader's schema (including the
 *    embedded `_conflicts` entries). Pass -> write as-is with the normal exit.
 * 2. Pass-through exemption: fires only when validation fails AND ours ITSELF
 *    already failed the schema AND the merged CONTENT equals ours' content. In
 *    that case the input was already out-of-schema, so the driver introduced no
 *    new invalidity; write anyway (a pre-existing broken file must not become a
 *    new merge failure). When ours WAS valid the exemption is skipped, so
 *    theirs-sourced malformed `_conflicts` entries (invisible to the body-only
 *    comparison) drop through the fallback ladder instead of being written
 *    (ISS-770).
 * 3. Fallback ladder: a loadable candidate built from one side's body plus a
 *    whole-entity conflict entry carrying all three snapshots. NOTE the
 *    semantic overload: the fallback entry uses kind "field" (NOT a new enum
 *    value -- an unknown kind would make the file invisible to every pre-fix
 *    build, the exact ISS-747 failure) with field "_entity" meaning
 *    whole-entity; recognition keys on field/fieldPath, never kind. Malformed
 *    carried entries are dropped from the fallback only (the snapshots already
 *    preserve all content). Try ours' body, then theirs'; first loadable
 *    candidate wins, exit 1.
 * 4. Both candidates invalid -> the inputs were schema-broken before this
 *    merge: hard error, NOTHING written, exit 2 (git keeps the pre-populated
 *    %A in the worktree and marks the path conflicted).
 */
export function finalizeMergeOutput(
  strategy: MergeStrategy,
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  result: MergeResult,
): { merged: Record<string, unknown>; exit: 0 | 1 } | { hardError: string } {
  const schema = schemaFor(strategy);
  const normalExit: 0 | 1 = result.clean ? 0 : 1;

  const parsed = schema.safeParse(result.merged);
  if (parsed.success) {
    return { merged: result.merged, exit: normalExit };
  }

  const oursValid = schema.safeParse(ours).success;
  if (!oursValid && deepEqual(stripConflicts(result.merged), stripConflicts(ours))) {
    return { merged: result.merged, exit: normalExit };
  }

  const carriedValid = carryForward(base, ours, theirs).filter((e) => {
    if (ConflictEntrySchema.safeParse(e).success) return true;
    diag(`dropping malformed carried conflict entry at "${String(e.fieldPath ?? "?")}" from the fallback output`);
    return false;
  });

  const entityFallbackEntry = {
    fieldPath: "", field: "_entity", kind: "field",
    base: entitySnapshot(base),
    ours: entitySnapshot(ours),
    theirs: entitySnapshot(theirs),
  };

  for (const sideBody of [ours, theirs]) {
    const candidate: Record<string, unknown> = {
      ...stripConflicts(sideBody),
      _conflicts: [entityFallbackEntry, ...carriedValid],
    };
    if (schema.safeParse(candidate).success) {
      return { merged: candidate, exit: 1 };
    }
  }

  const firstIssue = parsed.error.issues[0];
  const detail = firstIssue ? `${firstIssue.path.join(".") || "(root)"}: ${firstIssue.message}` : "schema validation failed";
  return { hardError: detail };
}

export function handleMergeDriver(
  ancestorPath: string,
  oursPath: string,
  theirsPath: string,
  pathname: string,
): number {
  const strategy = strategyFromPath(pathname);
  if (!strategy) {
    diag(`unknown .story path "${pathname}" (no merge strategy)`);
    return 2;
  }

  let base: Record<string, unknown>;
  let ours: Record<string, unknown>;
  let theirs: Record<string, unknown>;

  try {
    // An add/add conflict has no common ancestor, so git supplies an empty file
    // as %O. Treat an empty/whitespace ancestor as an empty base object so the
    // merge can still run: identical content on both sides merges clean, while
    // genuine field divergence (including displayId) still surfaces as a
    // structured _conflicts block rather than raw git conflict markers.
    const rawBase = readFileSync(ancestorPath, "utf-8");
    base = rawBase.trim() === "" ? {} : JSON.parse(rawBase);
    ours = JSON.parse(readFileSync(oursPath, "utf-8"));
    theirs = JSON.parse(readFileSync(theirsPath, "utf-8"));
  } catch (err) {
    diag(`cannot read/parse merge inputs for "${pathname}": ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  for (const [side, val] of [["base", base], ["ours", ours], ["theirs", theirs]] as const) {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      diag(`${side} of "${pathname}" is not a JSON object`);
      return 2;
    }
  }

  let result: MergeResult;
  try {
    if (strategy.kind === "config") {
      result = mergeConfig(base, ours, theirs);
    } else if (strategy.kind === "roadmap") {
      result = mergeRoadmap(base, ours, theirs);
    } else {
      result = threeWayMerge(base, ours, theirs, strategy.entityType);
    }
  } catch (err) {
    diag(`merge failed for "${pathname}": ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const final = finalizeMergeOutput(strategy, base, ours, theirs, result);
  if ("hardError" in final) {
    diag(`"${pathname}" would be unloadable after merge and both sides are schema-broken (${final.hardError}); nothing written`);
    return 2;
  }

  try {
    writeFileSync(oursPath, JSON.stringify(final.merged, null, 2) + "\n", "utf-8");
  } catch (err) {
    diag(`cannot write merge output for "${pathname}": ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  return final.exit;
}
