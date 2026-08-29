import type { ProjectState } from "./project-state.js";
import { ProjectLoaderError } from "./errors.js";

export interface ConflictedItem {
  type: "ticket" | "issue" | "note" | "lesson" | "config" | "roadmap" | "arrangement";
  id: string;
  conflictCount: number;
}

export interface ConflictsReport {
  hasConflicts: boolean;
  items: ConflictedItem[];
}

/**
 * `arrangements` is optional and additive-only: arrangements are not on
 * `ProjectState` (T-473 binding item 2 keeps them off the strict load path),
 * so this is the only way `storybloq conflicts` can see one. `assertNoConflicts`
 * below deliberately does NOT gain this parameter -- that would route
 * arrangement conflicts through the write-blocking assertion nearly every
 * ordinary ticket/issue/note/lesson write goes through, violating the same
 * binding item.
 */
export function hasConflicts(
  state: ProjectState,
  arrangements?: readonly { id: string; _conflicts?: unknown[] }[],
): ConflictsReport {
  const items: ConflictedItem[] = [];

  function scan(collection: readonly { id: string }[], type: ConflictedItem["type"]): void {
    for (const item of collection) {
      const conflicts = (item as Record<string, unknown>)._conflicts;
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        items.push({ type, id: item.id, conflictCount: conflicts.length });
      }
    }
  }

  scan(state.tickets, "ticket");
  scan(state.issues, "issue");
  scan(state.notes, "note");
  scan(state.lessons, "lesson");
  if (arrangements) scan(arrangements, "arrangement");

  const configConflicts = (state.config as Record<string, unknown>)._conflicts;
  if (Array.isArray(configConflicts) && configConflicts.length > 0) {
    items.push({ type: "config", id: "config.json", conflictCount: configConflicts.length });
  }
  const roadmapConflicts = (state.roadmap as Record<string, unknown>)._conflicts;
  if (Array.isArray(roadmapConflicts) && roadmapConflicts.length > 0) {
    items.push({ type: "roadmap", id: "roadmap.json", conflictCount: roadmapConflicts.length });
  }

  return { hasConflicts: items.length > 0, items };
}

export function assertNoConflicts(state: ProjectState): void {
  const report = hasConflicts(state);
  if (!report.hasConflicts) return;
  const summary = report.items.map((i) => `${i.id} (${i.conflictCount})`).join(", ");
  throw new ProjectLoaderError(
    "conflicts_present",
    `Cannot write: ${report.items.length} item(s) have unresolved conflicts: ${summary}. ` +
    `Run \`storybloq conflicts list\` to inspect, then \`storybloq resolve <id> --use ours|theirs\`. ` +
    `For config.json/roadmap.json use \`storybloq resolve config\` or \`storybloq resolve roadmap\`.`,
  );
}
