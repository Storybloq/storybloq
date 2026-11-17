import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LatestHandoverInfo {
  filename: string;
  date: string | null;
  heading: string | null;
}

/**
 * The heading federation shows for a handover: the first line matching
 * `^#\s+(.+)` (multiline), trimmed, clipped to 117 characters plus "..."
 * when longer than 120. Pure, so the handover lineage write-time check
 * (ISS-1499) compares exactly what this reader derives.
 */
export function extractHandoverHeading(content: string): string | null {
  const headingMatch = content.match(/^#\s+(.+)/m);
  if (!headingMatch) return null;
  const heading = headingMatch[1]!.trim();
  return heading.length > 120 ? heading.slice(0, 117) + "..." : heading;
}

/**
 * The listing step: every `.md` name, newest first by plain string order.
 * Shared by `findLatestHandover` and the compact pointer (ISS-1499 slice B)
 * so both use the identical order.
 */
export function handoverNamesNewestFirst(files: readonly string[]): string[] {
  return files.filter((f) => f.endsWith(".md")).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

/** The date the pointer shows for a handover name, or null. */
export function handoverNameDate(name: string): string | null {
  const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return dateMatch ? dateMatch[1]! : null;
}

/** `signal` (T-486 U2-3b): checked before each read, so a node scan's deadline stops it. */
export async function findLatestHandover(handoversDir: string, signal?: AbortSignal): Promise<LatestHandoverInfo | null> {
  signal?.throwIfAborted();
  const files = await readdir(handoversDir);
  const latest = handoverNamesNewestFirst(files)[0];
  if (latest === undefined) return null;
  const date = handoverNameDate(latest);

  let heading: string | null = null;
  signal?.throwIfAborted();
  try {
    const content = await readFile(join(handoversDir, latest), "utf-8");
    heading = extractHandoverHeading(content);
  } catch {
    // read error, skip heading
  }

  return { filename: latest, date, heading };
}
