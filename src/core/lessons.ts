/**
 * Lesson digest builder — compiles active lessons into ranked markdown.
 * Sorted by reinforcements descending, grouped by tag.
 */
import type { Lesson } from "../models/lesson.js";

/**
 * Builds a ranked markdown digest of active lessons.
 * Primary sort: reinforcements descending (most reinforced = most important).
 * Grouping: by first tag (ungrouped if no tags).
 */
export function buildLessonDigest(lessons: readonly Lesson[]): string {
  const active = lessons.filter((l) => l.status === "active");
  if (active.length === 0) return "";

  // Group by first tag
  const grouped = new Map<string, Lesson[]>();
  for (const l of active) {
    const group = l.tags.length > 0 ? l.tags[0]! : "general";
    const arr = grouped.get(group);
    if (arr) {
      arr.push(l);
    } else {
      grouped.set(group, [l]);
    }
  }

  // Sort each group by reinforcements desc, then createdDate desc
  for (const [, arr] of grouped) {
    arr.sort((a, b) => {
      if (b.reinforcements !== a.reinforcements) return b.reinforcements - a.reinforcements;
      return b.createdDate.localeCompare(a.createdDate);
    });
  }

  // Sort groups by max reinforcement in group (highest first)
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map((l) => l.reinforcements));
    const maxB = Math.max(...b[1].map((l) => l.reinforcements));
    return maxB - maxA;
  });

  const lines: string[] = ["# Lessons Learned", ""];
  for (const [group, lessons] of sortedGroups) {
    lines.push(`## ${group}`, "");
    for (const l of lessons) {
      const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
      lines.push(`- **${l.title}**${reinforced}: ${l.content}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
