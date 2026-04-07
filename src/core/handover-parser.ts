import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { LoadWarning } from "./errors.js";

const HANDOVER_DATE_REGEX = /^\d{4}-\d{2}-\d{2}/;
const HANDOVER_SEQ_REGEX = /^(\d{4}-\d{2}-\d{2})-(\d{2})-/;

/**
 * Lists handover markdown files, sorted by date (newest first).
 * Non-conforming filenames (no YYYY-MM-DD prefix) are appended at end
 * and flagged as naming_convention warnings.
 */
export async function listHandovers(
  handoversDir: string,
  root: string,
  warnings: LoadWarning[],
): Promise<string[]> {
  if (!existsSync(handoversDir)) return [];

  let entries: string[];
  try {
    entries = await readdir(handoversDir);
  } catch (err) {
    warnings.push({
      file: relative(root, handoversDir),
      message: `Cannot enumerate handovers: ${err instanceof Error ? err.message : String(err)}`,
      type: "parse_error",
    });
    return [];
  }

  const conforming: string[] = [];
  const nonConforming: string[] = [];

  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    if (extname(entry) !== ".md") continue;

    if (HANDOVER_DATE_REGEX.test(entry)) {
      conforming.push(entry);
    } else {
      nonConforming.push(entry);
      warnings.push({
        file: relative(root, join(handoversDir, entry)),
        message: "Handover filename does not start with YYYY-MM-DD date prefix.",
        type: "naming_convention",
      });
    }
  }

  // Newest first. For same-date entries, sequenced files (YYYY-MM-DD-NN-*)
  // from `handover create` sort before non-sequenced legacy files.
  // Contract: `handover create` is the supported creation path. Manual file
  // creation with non-sequenced names on the same day as sequenced files is
  // unsupported and may produce incorrect ordering.
  conforming.sort((a, b) => {
    const dateA = a.slice(0, 10);
    const dateB = b.slice(0, 10);
    if (dateA !== dateB) return dateB.localeCompare(dateA); // newest date first

    // Same date — sequenced files sort before non-sequenced
    const seqA = a.match(HANDOVER_SEQ_REGEX);
    const seqB = b.match(HANDOVER_SEQ_REGEX);
    if (seqA && !seqB) return -1; // a is sequenced, b is not → a first
    if (!seqA && seqB) return 1;  // b is sequenced, a is not → b first
    // Both sequenced or both non-sequenced — reverse lex
    return b.localeCompare(a);
  });

  return [...conforming, ...nonConforming];
}

/** Reads the content of a handover markdown file. */
export async function readHandover(
  handoversDir: string,
  filename: string,
): Promise<string> {
  return readFile(join(handoversDir, filename), "utf-8");
}

/**
 * Extracts the YYYY-MM-DD date prefix from a handover filename.
 * Returns the date string or null if the filename does not conform.
 */
export function extractHandoverDate(filename: string): string | null {
  const match = filename.match(HANDOVER_DATE_REGEX);
  return match ? match[0] : null;
}

/**
 * Extracts the human-readable title from a handover filename.
 * Strips `.md` extension and YYYY-MM-DD date prefix, converts remaining
 * hyphens to spaces, and trims whitespace. Mirrors Swift parseHandoverFilename.
 */
export function extractHandoverTitle(filename: string): string {
  let name = filename;
  if (name.endsWith(".md")) {
    name = name.slice(0, -3);
  }

  if (HANDOVER_DATE_REGEX.test(name)) {
    // Strip YYYY-MM-DD prefix (10 chars)
    let title = name.slice(10);
    // Strip leading hyphen separator
    if (title.startsWith("-")) {
      title = title.slice(1);
    }
    return title.replace(/-/g, " ").trim();
  }

  return name;
}
