import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

/**
 * C-v4.1 3.5: read-only views of the `landings` metadata that `storybloq land`
 * writes (land.ts LandReceiptEntry). land stays the only landing writer.
 *
 * - Each view carries `source: "land-metadata"` and a stable id: `lm-` plus the
 *   first 16 hex characters of sha256 over `canonicalJson(entry)`, so key order
 *   on disk never changes it and the merge rule can key `landings` by it.
 * - A missing field reads `"unavailable"`; nothing is defaulted.
 * - A legacy landing never says the sha is reachable now: `reachability` is
 *   always `"unavailable"`; current reachability is a git fact (section 4).
 * - Identical entries collapse to one view (dedup by legacy id), first seen first.
 */

export const LEGACY_LANDING_ID_REGEX = /^lm-[0-9a-f]{16}$/;

const UNAVAILABLE = "unavailable" as const;
type Field = string | typeof UNAVAILABLE;

export interface LegacyLandingView {
  readonly source: "land-metadata";
  readonly id: string;
  readonly sha: Field;
  readonly remote: Field;
  readonly remoteUrl: Field;
  readonly branch: Field;
  readonly priorTip: Field;
  readonly landedAt: Field;
  readonly steps: readonly unknown[] | typeof UNAVAILABLE;
  readonly reachability: typeof UNAVAILABLE;
}

/** The stable legacy id of one landings element, or undefined when it cannot be canonicalised. */
export function legacyLandingId(entry: unknown): string | undefined {
  try {
    return `lm-${createHash("sha256").update(canonicalJson(entry)).digest("hex").slice(0, 16)}`;
  } catch {
    return undefined;
  }
}

const field = (entry: Record<string, unknown>, key: string): Field => {
  const value = entry[key];
  return typeof value === "string" && value.length > 0 ? value : UNAVAILABLE;
};

export function projectLegacyLandings(record: Record<string, unknown>): LegacyLandingView[] {
  const raw = record.landings;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LegacyLandingView[] = [];
  for (const element of raw) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) continue;
    const id = legacyLandingId(element);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = element as Record<string, unknown>;
    out.push({
      source: "land-metadata",
      id,
      sha: field(entry, "sha"),
      remote: field(entry, "remote"),
      remoteUrl: field(entry, "remoteUrl"),
      branch: field(entry, "branch"),
      priorTip: field(entry, "priorTip"),
      landedAt: field(entry, "landedAt"),
      steps: Array.isArray(entry.steps) ? entry.steps : UNAVAILABLE,
      reachability: UNAVAILABLE,
    });
  }
  return out;
}
