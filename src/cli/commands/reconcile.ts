import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeReconcilePlan, computeRebalancePlan, type EntityType, type ReconcileContext, type ReconcileRename } from "../../core/reconcile.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { formatReconcileResult, ExitCode, successEnvelope, type ExitCodeValue } from "../../core/output-formatter.js";
import { withProjectLock, runTransactionUnlocked } from "../../core/project-loader.js";
import { nextNoteID, allocateTeamNoteId, NOTE_NUMERIC_REGEX } from "../../core/id-allocation.js";
import { listReservations } from "../../core/remote-refs.js";
import type { ProjectState } from "../../core/project-state.js";
import type { Note } from "../../models/note.js";
import type { CommandResult } from "../types.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTeamModeConfig } from "../../core/team-capabilities.js";

export interface ReconcileOptions {
  readonly dryRun: boolean;
  readonly ci: boolean;
  readonly rebalanceRanks?: boolean;
  readonly format: "md" | "json";
}

const execFileAsync = promisify(execFile);

const ENTITY_DIRS: Record<EntityType, string> = {
  ticket: "tickets",
  issue: "issues",
  note: "notes",
  lesson: "lessons",
};

const ENTITY_TYPES: readonly EntityType[] = ["ticket", "issue", "note", "lesson"];

interface RankChange {
  id: string;
  entityType: EntityType;
  newRank: string;
}

async function gitStdout(root: string, args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf-8",
    timeout,
  });
  return String(stdout);
}

async function buildReconcileContext(root: string, state: ProjectState): Promise<ReconcileContext> {
  const warnings: NonNullable<ReconcileContext["warnings"]> = [];
  const reservations: NonNullable<ReconcileContext["reservations"]> = {};
  const protectedOwners: NonNullable<ReconcileContext["protectedOwners"]> = {};

  const team = state.config.team;
  if (!isTeamModeConfig(state.config) || !team) {
    return { reservations, protectedOwners, warnings };
  }

  if (team.idAllocator === "git-refs") {
    for (const entityType of ENTITY_TYPES) {
      try {
        const refs = await listReservations(root, entityType, state);
        const owners = new Map<string, string>();
        for (const ref of refs) {
          if (ref.ownerId) owners.set(ref.displayId, ref.ownerId);
        }
        reservations[entityType] = owners;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push({ message: `Could not inspect ${entityType} reservation refs: ${message}` });
      }
    }
  }

  const protectedRef = team.protectedRef ?? "origin/main";
  try {
    const mergeBase = (await gitStdout(root, ["merge-base", "HEAD", protectedRef], 10000)).trim();
    if (mergeBase) {
      for (const entityType of ENTITY_TYPES) {
        const dir = ENTITY_DIRS[entityType];
        try {
          const stdout = await gitStdout(root, ["ls-tree", "-r", "--name-only", mergeBase, `.story/${dir}`], 10000);
          const owners = new Set<string>();
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.endsWith(".json")) continue;
            const fileName = trimmed.slice(trimmed.lastIndexOf("/") + 1);
            owners.add(fileName.replace(/\.json$/, ""));
          }
          protectedOwners[entityType] = owners;
        } catch {
          protectedOwners[entityType] = new Set();
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({
      message: `Could not inspect protected ref "${protectedRef}" for reconcile ownership. Falling back to timestamps and canonical IDs. ${message}`,
    });
  }

  return { reservations, protectedOwners, warnings };
}

async function applyChanges(
  root: string,
  renames: ReconcileRename[],
  rankChanges: RankChange[],
  extraOps?: Array<{ op: "write"; target: string; content: string }>,
): Promise<void> {
  const storyDir = join(root, ".story");
  const operations: Array<{ op: "write"; target: string; content: string }> = [];

  const rankById = new Map<string, string>();
  for (const c of rankChanges) rankById.set(c.id, c.newRank);

  const handled = new Set<string>();

  for (const rename of renames) {
    const dir = ENTITY_DIRS[rename.entityType];
    if (!dir) continue;
    // ISS-710: canonical IDs ARE filenames (documented invariant), so build the
    // path directly -- matching the rank loop below -- instead of reading and
    // scanning the whole directory per rename. A single existence check keeps the
    // prior skip-on-missing behavior (rather than throwing) for a stale rename.
    const filePath = join(storyDir, dir, `${rename.id}.json`);
    if (!existsSync(filePath)) continue;
    const raw = await readFile(filePath, "utf-8");
    const entity = JSON.parse(raw) as Record<string, unknown>;
    entity.displayId = rename.newDisplayId;
    const prev = Array.isArray(entity.previousDisplayIds) ? [...entity.previousDisplayIds] : [];
    if (!prev.includes(rename.oldDisplayId)) prev.push(rename.oldDisplayId);
    entity.previousDisplayIds = prev;
    const newRank = rankById.get(rename.id);
    if (newRank !== undefined) entity.rank = newRank;
    operations.push({ op: "write", target: filePath, content: JSON.stringify(entity, null, 2) + "\n" });
    handled.add(rename.id);
  }

  for (const change of rankChanges) {
    if (handled.has(change.id)) continue;
    const dir = ENTITY_DIRS[change.entityType];
    if (!dir) continue;
    const filePath = join(storyDir, dir, `${change.id}.json`);
    const raw = await readFile(filePath, "utf-8");
    const entity = JSON.parse(raw) as Record<string, unknown>;
    entity.rank = change.newRank;
    operations.push({ op: "write", target: filePath, content: JSON.stringify(entity, null, 2) + "\n" });
  }

  if (extraOps) operations.push(...extraOps);
  if (operations.length > 0) {
    await runTransactionUnlocked(root, operations);
  }
}

export async function handleReconcile(
  root: string,
  options: ReconcileOptions,
): Promise<CommandResult> {
  let output = "";
  let exitCode: ExitCodeValue = ExitCode.OK;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const context = await buildReconcileContext(root, state);
    const arrangementScan = loadArrangementsSafe(root);
    const result = computeReconcilePlan(state, context, arrangementScan);
    const rebalance = options.rebalanceRanks ? computeRebalancePlan(state) : null;
    const rankChanges: RankChange[] = rebalance
      ? rebalance.changes.map((c) => ({ id: c.id, entityType: c.entityType, newRank: c.newRank }))
      : [];
    const rebalanceMsg = rebalance && rebalance.changes.length > 0
      ? `\nRebalanced ${rebalance.changes.length} rank(s) across ${rebalance.phasesRebalanced} phase(s).`
      : "";

    if (!result.ok) {
      output = formatReconcileResult(result, options.format);
      exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    if (options.ci) {
      if (result.plan.renames.length > 0 || rankChanges.length > 0) {
        output = formatReconcileOutput(result, options.format, rebalance);
        exitCode = ExitCode.USER_ERROR;
      } else {
        // ISS-805: honor --format json in the clean branch too, using the same
        // successEnvelope shape the other reconcile JSON paths emit. Interactive
        // callers keep the plain-text confirmation.
        output = options.format === "json"
          ? JSON.stringify(successEnvelope({ clean: true, renames: [] }), null, 2)
          : "No duplicate displayIds found. Project is clean.";
        exitCode = ExitCode.OK;
      }
      return;
    }

    if (options.dryRun || (result.plan.renames.length === 0 && rankChanges.length === 0)) {
      output = formatReconcileOutput(result, options.format, rebalance);
      exitCode = ExitCode.OK;
      return;
    }

    const noteOp = result.plan.renames.length > 0 ? buildMappingNoteOp(root, state, result.plan.renames) : undefined;
    await applyChanges(root, result.plan.renames, rankChanges, noteOp ? [noteOp] : []);

    output = formatReconcileOutput(result, options.format, rebalance);
    exitCode = ExitCode.OK;
  });

  return { output, exitCode };
}

function buildMappingNoteOp(
  root: string,
  state: ProjectState,
  renames: ReconcileRename[],
): { op: "write"; target: string; content: string } {
  const lines = [
    "# Reconcile Mapping",
    "",
    `Reconciled ${renames.length} duplicate displayId(s).`,
    "",
    "| Entity | Old DisplayId | New DisplayId | Reason |",
    "|--------|--------------|--------------|--------|",
  ];
  for (const r of renames) {
    lines.push(`| ${r.id} | ${r.oldDisplayId} | ${r.newDisplayId} | ${r.reason} |`);
  }
  const isTeam = isTeamModeConfig(state.config);
  let noteId: string;
  let noteDisplayId: string | undefined;
  if (isTeam) {
    const alloc = allocateTeamNoteId(state.notes);
    noteId = alloc.id;
    const maxFromNoteRenames = renames
      .filter((r) => r.entityType === "note")
      .reduce((max, r) => {
        const m = r.newDisplayId.match(NOTE_NUMERIC_REGEX);
        return m?.[1] ? Math.max(max, parseInt(m[1], 10)) : max;
      }, 0);
    const allocNum = parseInt(alloc.displayId.replace(/^N-0*/, ""), 10) || 0;
    noteDisplayId = `N-${String(Math.max(allocNum, maxFromNoteRenames + 1)).padStart(3, "0")}`;
  } else {
    noteId = nextNoteID(state.notes);
    noteDisplayId = undefined;
  }
  const createdAt = new Date().toISOString();
  const today = createdAt.slice(0, 10);
  const note: Note = {
    id: noteId,
    ...(noteDisplayId != null && { displayId: noteDisplayId }),
    title: "Reconcile mapping",
    content: lines.join("\n"),
    tags: ["reconcile"],
    status: "active",
    createdDate: today,
    ...(isTeam && { createdAt }),
    updatedDate: today,
  };
  const noteFilePath = join(root, ".story", "notes", `${noteId}.json`);
  return { op: "write", target: noteFilePath, content: JSON.stringify(note, null, 2) + "\n" };
}

function formatReconcileOutput(
  result: ReturnType<typeof computeReconcilePlan>,
  format: "md" | "json",
  rebalance: ReturnType<typeof computeRebalancePlan> | null,
): string {
  if (format === "json" && result.ok) {
    return JSON.stringify(successEnvelope({
      ...result.plan,
      ...(rebalance ? {
        rebalance: {
          changes: rebalance.changes.length,
          phasesRebalanced: rebalance.phasesRebalanced,
        },
      } : {}),
    }), null, 2);
  }
  const base = formatReconcileResult(result, format);
  if (!rebalance || rebalance.changes.length === 0) return base;
  return `${base}\nRebalanced ${rebalance.changes.length} rank(s) across ${rebalance.phasesRebalanced} phase(s).`;
}
