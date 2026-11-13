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

/** `signal` (T-486 U2-3b): checked before each read, so a node scan's deadline stops it. */
export async function findLatestHandover(handoversDir: string, signal?: AbortSignal): Promise<LatestHandoverInfo | null> {
  signal?.throwIfAborted();
  const files = await readdir(handoversDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  const latest = mdFiles.reduce((a, b) => (a > b ? a : b));
  const dateMatch = latest.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1]! : null;

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
