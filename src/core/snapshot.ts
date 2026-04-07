/**
 * Snapshot management: save, load, prune, and diff project state.
 *
 * Snapshots capture the full project state at a point in time for session diffs.
 * Stored in .story/snapshots/ as versioned JSON files.
 */
import { readdir, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { TicketSchema, type Ticket } from "../models/ticket.js";
import { IssueSchema, type Issue } from "../models/issue.js";
import { NoteSchema, type Note } from "../models/note.js";
import { LessonSchema, type Lesson } from "../models/lesson.js";
import { RoadmapSchema, type Roadmap } from "../models/roadmap.js";
import { ConfigSchema, type Config } from "../models/config.js";
import { ProjectState, type PhaseStatus } from "./project-state.js";
import { type LoadWarning } from "./errors.js";
import { phasesWithStatus, nextTicket, isBlockerCleared } from "./queries.js";
import type { LoadResult } from "./project-loader.js";
import { atomicWrite, guardPath } from "./project-loader.js";
import { gitHeadHash, gitIsAncestor, gitCommitDistance } from "../autonomous/git-inspector.js";

// --- Snapshot Schema ---

const LoadWarningSchema = z.object({
  type: z.string(),
  file: z.string(),
  message: z.string(),
});

export const SnapshotV1Schema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  project: z.string(),
  config: ConfigSchema,
  roadmap: RoadmapSchema,
  tickets: z.array(TicketSchema),
  issues: z.array(IssueSchema),
  notes: z.array(NoteSchema).optional().default([]),
  lessons: z.array(LessonSchema).optional().default([]),
  handoverFilenames: z.array(z.string()).optional().default([]),
  warnings: z.array(LoadWarningSchema).optional(),
  gitHead: z.string().optional(),
});

export type SnapshotV1 = z.infer<typeof SnapshotV1Schema>;

/** Maximum number of snapshots to retain. */
const MAX_SNAPSHOTS = 20;

// --- Save ---

/**
 * Creates a snapshot from the current project state.
 * Call inside withProjectLock for atomicity.
 * Returns the filename and prune count.
 */
export async function saveSnapshot(
  root: string,
  loadResult: LoadResult,
): Promise<{ filename: string; retained: number; pruned: number }> {
  const absRoot = resolve(root);
  const snapshotsDir = join(absRoot, ".story", "snapshots");
  await mkdir(snapshotsDir, { recursive: true });

  const { state, warnings } = loadResult;
  const now = new Date();
  const filename = formatSnapshotFilename(now);

  const snapshot: SnapshotV1 = {
    version: 1,
    createdAt: now.toISOString(),
    project: state.config.project,
    config: state.config as Config,
    roadmap: state.roadmap as Roadmap,
    tickets: [...state.tickets] as Ticket[],
    issues: [...state.issues] as Issue[],
    notes: [...state.notes] as Note[],
    lessons: [...state.lessons] as Lesson[],
    handoverFilenames: [...state.handoverFilenames],
    ...(warnings.length > 0
      ? {
          warnings: warnings.map((w) => ({
            type: w.type,
            file: w.file,
            message: w.message,
          })),
        }
      : {}),
  };

  // Resolve git HEAD SHA (best-effort, 3s timeout)
  const headResult = await gitHeadHash(absRoot);
  if (headResult.ok) {
    snapshot.gitHead = headResult.data;
  }

  const json = JSON.stringify(snapshot, null, 2) + "\n";
  const targetPath = join(snapshotsDir, filename);
  const wrapDir = join(absRoot, ".story");

  // Symlink protection + atomic write (same hardening as all project writes)
  await guardPath(targetPath, wrapDir);
  await atomicWrite(targetPath, json);

  // Prune old snapshots
  const pruned = await pruneSnapshots(snapshotsDir);
  const entries = await listSnapshotFiles(snapshotsDir);

  return { filename, retained: entries.length, pruned };
}

// --- Load ---

/**
 * Loads the latest valid snapshot from .story/snapshots/.
 * Scans in descending filename order, returns first valid file.
 * Returns null if no valid snapshots found.
 */
export async function loadLatestSnapshot(
  root: string,
): Promise<{ snapshot: SnapshotV1; filename: string } | null> {
  const snapshotsDir = join(resolve(root), ".story", "snapshots");
  if (!existsSync(snapshotsDir)) return null;

  const files = await listSnapshotFiles(snapshotsDir);
  if (files.length === 0) return null;

  // Descending order (newest first)
  for (const filename of files) {
    try {
      const content = await readFile(join(snapshotsDir, filename), "utf-8");
      const parsed = JSON.parse(content);
      const snapshot = SnapshotV1Schema.parse(parsed);
      return { snapshot, filename };
    } catch {
      // Skip corrupt/invalid snapshot, try next
      continue;
    }
  }

  return null;
}

// --- Diff ---

export interface TicketChange {
  id: string;
  title: string;
  from: string;
  to: string;
}

export interface IssueChange {
  id: string;
  title: string;
  from: string;
  to: string;
}

export interface PhaseChange {
  id: string;
  name: string;
  from: string;
  to: string;
}

export interface ContentChange {
  id: string;
  title: string;
}

export interface NoteChange {
  id: string;
  title: string | null;
  changedFields: string[];
}

export interface LessonChange {
  id: string;
  title: string;
  changedFields: string[];
}

export interface SnapshotDiff {
  tickets: {
    added: Array<{ id: string; title: string }>;
    removed: Array<{ id: string; title: string }>;
    statusChanged: TicketChange[];
    descriptionChanged: ContentChange[];
  };
  issues: {
    added: Array<{ id: string; title: string }>;
    resolved: Array<{ id: string; title: string }>;
    statusChanged: IssueChange[];
    impactChanged: ContentChange[];
  };
  blockers: {
    added: string[];
    cleared: string[];
  };
  phases: {
    added: Array<{ id: string; name: string }>;
    removed: Array<{ id: string; name: string }>;
    statusChanged: PhaseChange[];
  };
  notes: {
    added: Array<{ id: string; title: string | null }>;
    removed: Array<{ id: string; title: string | null }>;
    updated: NoteChange[];
  };
  lessons: {
    added: Array<{ id: string; title: string }>;
    removed: Array<{ id: string; title: string }>;
    updated: LessonChange[];
    reinforced: Array<{ id: string; title: string; from: number; to: number }>;
  };
  handovers: {
    added: string[];
    removed: string[];
  };
}

export interface RecapStaleness {
  status: "behind" | "diverged";
  snapshotSha: string;
  currentSha: string;
  commitsBehind?: number; // only present when status is "behind"
}

export interface RecapResult {
  snapshot: { filename: string; createdAt: string } | null;
  changes: SnapshotDiff | null;
  suggestedActions: {
    nextTicket: { id: string; title: string; phase: string | null } | null;
    highSeverityIssues: Array<{ id: string; title: string; severity: string }>;
    recentlyClearedBlockers: string[];
  };
  partial: boolean;
  staleness?: RecapStaleness;
}

/**
 * Computes the diff between a snapshot state and the current state.
 */
export function diffStates(
  snapshotState: ProjectState,
  currentState: ProjectState,
): SnapshotDiff {
  // --- Tickets ---
  const snapTickets = new Map(snapshotState.tickets.map((t) => [t.id, t]));
  const curTickets = new Map(currentState.tickets.map((t) => [t.id, t]));

  const ticketsAdded: Array<{ id: string; title: string }> = [];
  const ticketsRemoved: Array<{ id: string; title: string }> = [];
  const ticketsStatusChanged: TicketChange[] = [];
  const ticketsDescriptionChanged: ContentChange[] = [];

  for (const [id, cur] of curTickets) {
    const snap = snapTickets.get(id);
    if (!snap) {
      ticketsAdded.push({ id, title: cur.title });
    } else {
      if (snap.status !== cur.status) {
        ticketsStatusChanged.push({ id, title: cur.title, from: snap.status, to: cur.status });
      }
      if (snap.description !== cur.description) {
        ticketsDescriptionChanged.push({ id, title: cur.title });
      }
    }
  }
  for (const [id, snap] of snapTickets) {
    if (!curTickets.has(id)) {
      ticketsRemoved.push({ id, title: snap.title });
    }
  }

  // --- Issues ---
  const snapIssues = new Map(snapshotState.issues.map((i) => [i.id, i]));
  const curIssues = new Map(currentState.issues.map((i) => [i.id, i]));

  const issuesAdded: Array<{ id: string; title: string }> = [];
  const issuesResolved: Array<{ id: string; title: string }> = [];
  const issuesStatusChanged: IssueChange[] = [];
  const issuesImpactChanged: ContentChange[] = [];

  for (const [id, cur] of curIssues) {
    const snap = snapIssues.get(id);
    if (!snap) {
      issuesAdded.push({ id, title: cur.title });
    } else {
      if (snap.status !== cur.status) {
        if (cur.status === "resolved") {
          issuesResolved.push({ id, title: cur.title });
        } else {
          issuesStatusChanged.push({ id, title: cur.title, from: snap.status, to: cur.status });
        }
      }
      if (snap.impact !== cur.impact) {
        issuesImpactChanged.push({ id, title: cur.title });
      }
    }
  }

  // --- Blockers ---
  const snapBlockers = new Map(
    snapshotState.roadmap.blockers.map((b) => [b.name, b]),
  );
  const curBlockers = new Map(
    currentState.roadmap.blockers.map((b) => [b.name, b]),
  );

  const blockersAdded: string[] = [];
  const blockersCleared: string[] = [];

  for (const [name, cur] of curBlockers) {
    const snap = snapBlockers.get(name);
    if (!snap) {
      blockersAdded.push(name);
    } else if (!isBlockerCleared(snap) && isBlockerCleared(cur)) {
      blockersCleared.push(name);
    }
  }

  // --- Phases (compute status independently per Codex R1 #2) ---
  const snapPhases = snapshotState.roadmap.phases;
  const curPhases = currentState.roadmap.phases;
  const snapPhaseMap = new Map(snapPhases.map((p) => [p.id, p]));
  const curPhaseMap = new Map(curPhases.map((p) => [p.id, p]));

  const phasesAdded: Array<{ id: string; name: string }> = [];
  const phasesRemoved: Array<{ id: string; name: string }> = [];
  const phasesStatusChanged: PhaseChange[] = [];

  for (const [id, curPhase] of curPhaseMap) {
    const snapPhase = snapPhaseMap.get(id);
    if (!snapPhase) {
      phasesAdded.push({ id, name: curPhase.name });
    } else {
      const snapStatus = snapshotState.phaseStatus(id);
      const curStatus = currentState.phaseStatus(id);
      if (snapStatus !== curStatus) {
        phasesStatusChanged.push({
          id,
          name: curPhase.name,
          from: snapStatus,
          to: curStatus,
        });
      }
    }
  }
  for (const [id, snapPhase] of snapPhaseMap) {
    if (!curPhaseMap.has(id)) {
      phasesRemoved.push({ id, name: snapPhase.name });
    }
  }

  // --- Notes ---
  const snapNotes = new Map(snapshotState.notes.map((n) => [n.id, n]));
  const curNotes = new Map(currentState.notes.map((n) => [n.id, n]));

  const notesAdded: Array<{ id: string; title: string | null }> = [];
  const notesRemoved: Array<{ id: string; title: string | null }> = [];
  const notesUpdated: NoteChange[] = [];

  for (const [id, cur] of curNotes) {
    const snap = snapNotes.get(id);
    if (!snap) {
      notesAdded.push({ id, title: cur.title });
    } else {
      const changedFields: string[] = [];
      if (snap.title !== cur.title) changedFields.push("title");
      if (snap.content !== cur.content) changedFields.push("content");
      if (JSON.stringify([...snap.tags].sort()) !== JSON.stringify([...cur.tags].sort())) changedFields.push("tags");
      if (snap.status !== cur.status) changedFields.push("status");
      if (changedFields.length > 0) {
        notesUpdated.push({ id, title: cur.title, changedFields });
      }
    }
  }
  for (const [id, snap] of snapNotes) {
    if (!curNotes.has(id)) {
      notesRemoved.push({ id, title: snap.title });
    }
  }

  // --- Lessons ---
  const snapLessons = new Map(snapshotState.lessons.map((l) => [l.id, l]));
  const curLessons = new Map(currentState.lessons.map((l) => [l.id, l]));

  const lessonsAdded: Array<{ id: string; title: string }> = [];
  const lessonsRemoved: Array<{ id: string; title: string }> = [];
  const lessonsUpdated: LessonChange[] = [];
  const lessonsReinforced: Array<{ id: string; title: string; from: number; to: number }> = [];

  for (const [id, cur] of curLessons) {
    const snap = snapLessons.get(id);
    if (!snap) {
      lessonsAdded.push({ id, title: cur.title });
    } else {
      const changedFields: string[] = [];
      if (snap.title !== cur.title) changedFields.push("title");
      if (snap.content !== cur.content) changedFields.push("content");
      if (snap.context !== cur.context) changedFields.push("context");
      if (snap.status !== cur.status) changedFields.push("status");
      if (JSON.stringify([...snap.tags].sort()) !== JSON.stringify([...cur.tags].sort())) changedFields.push("tags");
      if (snap.supersedes !== cur.supersedes) changedFields.push("supersedes");
      if (changedFields.length > 0) {
        lessonsUpdated.push({ id, title: cur.title, changedFields });
      }
      if (snap.reinforcements !== cur.reinforcements) {
        lessonsReinforced.push({ id, title: cur.title, from: snap.reinforcements, to: cur.reinforcements });
      }
    }
  }
  for (const [id, snap] of snapLessons) {
    if (!curLessons.has(id)) {
      lessonsRemoved.push({ id, title: snap.title });
    }
  }

  // --- Handovers ---
  const snapHandovers = new Set(snapshotState.handoverFilenames);
  const curHandovers = new Set(currentState.handoverFilenames);

  const handoversAdded: string[] = [];
  const handoversRemoved: string[] = [];

  for (const h of curHandovers) {
    if (!snapHandovers.has(h)) handoversAdded.push(h);
  }
  for (const h of snapHandovers) {
    if (!curHandovers.has(h)) handoversRemoved.push(h);
  }

  return {
    tickets: { added: ticketsAdded, removed: ticketsRemoved, statusChanged: ticketsStatusChanged, descriptionChanged: ticketsDescriptionChanged },
    issues: { added: issuesAdded, resolved: issuesResolved, statusChanged: issuesStatusChanged, impactChanged: issuesImpactChanged },
    blockers: { added: blockersAdded, cleared: blockersCleared },
    phases: { added: phasesAdded, removed: phasesRemoved, statusChanged: phasesStatusChanged },
    notes: { added: notesAdded, removed: notesRemoved, updated: notesUpdated },
    lessons: { added: lessonsAdded, removed: lessonsRemoved, updated: lessonsUpdated, reinforced: lessonsReinforced },
    handovers: { added: handoversAdded, removed: handoversRemoved },
  };
}

/**
 * Builds a full RecapResult: diff + suggested actions.
 */
export async function buildRecap(
  currentState: ProjectState,
  snapshotInfo: { snapshot: SnapshotV1; filename: string } | null,
  root: string,
): Promise<RecapResult> {
  // Suggested actions (always computed, even without snapshot)
  const next = nextTicket(currentState);
  const nextTicketAction =
    next.kind === "found"
      ? { id: next.ticket.id, title: next.ticket.title, phase: next.ticket.phase }
      : null;

  const highSeverityIssues = currentState.issues
    .filter(
      (i) =>
        i.status !== "resolved" &&
        (i.severity === "critical" || i.severity === "high"),
    )
    .map((i) => ({ id: i.id, title: i.title, severity: i.severity }));

  if (!snapshotInfo) {
    return {
      snapshot: null,
      changes: null,
      suggestedActions: {
        nextTicket: nextTicketAction,
        highSeverityIssues,
        recentlyClearedBlockers: [],
      },
      partial: false,
    };
  }

  const { snapshot, filename } = snapshotInfo;

  // Build ProjectState from snapshot data
  const snapshotState = new ProjectState({
    tickets: snapshot.tickets,
    issues: snapshot.issues,
    notes: snapshot.notes ?? [],
    lessons: snapshot.lessons ?? [],
    roadmap: snapshot.roadmap,
    config: snapshot.config,
    handoverFilenames: snapshot.handoverFilenames ?? [],
  });

  const changes = diffStates(snapshotState, currentState);

  // Recently cleared blockers (in diff)
  const recentlyClearedBlockers = changes.blockers.cleared;

  // Git staleness detection (T-132)
  let staleness: RecapStaleness | undefined;
  if (snapshot.gitHead) {
    const currentHeadResult = await gitHeadHash(root);
    if (currentHeadResult.ok) {
      const snapshotSha = snapshot.gitHead;
      const currentSha = currentHeadResult.data;

      if (snapshotSha !== currentSha) {
        const ancestorResult = await gitIsAncestor(root, snapshotSha, currentSha);
        if (ancestorResult.ok && ancestorResult.data) {
          // Snapshot is an ancestor of HEAD -- count commits behind
          const distResult = await gitCommitDistance(root, snapshotSha, currentSha);
          if (distResult.ok) {
            staleness = {
              status: "behind",
              snapshotSha,
              currentSha,
              commitsBehind: distResult.data,
            };
          }
          // If distResult fails, omit staleness entirely for consistent degradation
        } else if (ancestorResult.ok && !ancestorResult.data) {
          // Not an ancestor -- history diverged
          staleness = { status: "diverged", snapshotSha, currentSha };
        }
        // If ancestorResult is not ok (git error), omit staleness silently
      }
      // If same SHA, omit staleness (snapshot is current)
    }
    // If gitHeadHash fails (not a repo, git unavailable), omit staleness silently
  }

  return {
    snapshot: { filename, createdAt: snapshot.createdAt },
    changes,
    suggestedActions: {
      nextTicket: nextTicketAction,
      highSeverityIssues,
      recentlyClearedBlockers,
    },
    partial: (snapshot.warnings ?? []).length > 0,
    ...(staleness ? { staleness } : {}),
  };
}

// --- Helpers ---

function formatSnapshotFilename(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${y}-${mo}-${d}T${h}-${mi}-${s}-${ms}.json`;
}

async function listSnapshotFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

async function pruneSnapshots(dir: string): Promise<number> {
  const files = await listSnapshotFiles(dir);
  if (files.length <= MAX_SNAPSHOTS) return 0;

  const toRemove = files.slice(MAX_SNAPSHOTS);
  for (const f of toRemove) {
    try {
      await unlink(join(dir, f));
    } catch {
      // ignore individual delete failures
    }
  }
  return toRemove.length;
}
