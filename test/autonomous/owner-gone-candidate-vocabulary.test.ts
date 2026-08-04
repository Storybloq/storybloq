/**
 * T-450 step 9.1: the owner-gone-CANDIDATE vocabulary, as a property over the
 * surfaces rather than an assertion on one of them.
 *
 * RULING A of this ticket is that owner-task death is NOT determinable from
 * anything on disk. Every surface therefore presents a CANDIDATE with its
 * evidence, never a verdict, and amendment D applied that to the recovery
 * sentence specifically: the phrase is "explicit owner-gone-candidate
 * confirmation flow", with no allowlist, because an allowlist weakens exactly
 * the property ruling A asserts.
 *
 * WHY THIS FILE EXISTS AT ALL. Step 9's audit declared this criterion satisfied
 * while all three shipped sites carried the PRE-amendment wording. The record
 * said "already present and correct" because the check performed was "does this
 * line mention a confirmation flow" rather than "does this line say what the
 * amendment requires". The acceptance for the fixup was a manual grep; a manual
 * grep is a one-time observation, and the thing that failed here was precisely
 * an observation being trusted twice. This file is that grep made executable.
 *
 * It scans the SHIPPED SOURCES rather than calling the functions, deliberately.
 * The property is about what strings exist to be read by an operator, and three
 * of the four sites are in different modules with different call shapes; a
 * behavioural test per site would pin four call paths and still miss a fifth
 * site added later. This scan cannot miss a new site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG, "src");

/** The wording amendment D retired. It asserts a determination the system
 * cannot make, which is the whole of ruling A. */
const RETIRED = "explicit owner-gone confirmation flow";
const REQUIRED = "explicit owner-gone-candidate confirmation flow";

/** Every shipped source and skill file, so a site added tomorrow is covered
 * without this list being maintained. */
function surfaceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...surfaceFiles(full));
    else if (/\.(ts|md)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = surfaceFiles(SRC);

/** Package-relative, forward-slashed on every platform. `sep` is what makes
 * this real rather than decorative: on Windows the paths arrive backslashed and
 * would never match the expectations below. */
const rel = (f: string): string => relative(PKG, f).split(sep).join("/");

describe("T-450: the recovery sentence says CANDIDATE on every surface", () => {
  it("has at least one surface to check, so the scan cannot pass by finding nothing", () => {
    // The failure mode of a whole-tree scan is scanning an empty tree and
    // reporting a clean result. Pinned first so everything below means something.
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("carries the RETIRED wording nowhere in shipped source or skill text", () => {
    const offenders = FILES.filter((f) => {
      const text = readFileSync(f, "utf-8");
      // The required phrase CONTAINS the retired one only if you ignore the
      // hyphen, which is the point: `owner-gone-candidate` does not contain
      // `owner-gone ` (with the trailing space before "confirmation").
      return text.includes(RETIRED);
    }).map(rel);

    expect(offenders, `pre-amendment wording still shipped in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("carries the REQUIRED wording on exactly four occurrences across three files", () => {
    // A COUNT MAP, not a carrier list. Exactly, not at-least, in both
    // directions: a site that quietly LOSES the sentence is as much a
    // regression as one that carries the old wording, and a file that gains a
    // second copy is a surface nobody decided to add. A set of filenames
    // catches neither -- guide.ts legitimately holds two, so only per-file
    // counts can tell "two on purpose" from "one lost" or "three by accident".
    const counts: Record<string, number> = {};
    for (const f of FILES) {
      const n = readFileSync(f, "utf-8").split(REQUIRED).length - 1;
      if (n > 0) counts[rel(f)] = n;
    }

    expect(counts).toEqual({
      "src/autonomous/guide.ts": 2,
      "src/cli/commands/session-compact.ts": 1,
      "src/skill/SKILL.md": 1,
    });
  });

  // WHAT THIS FILE DELIBERATELY DOES NOT TRY TO PIN, so the omission is a
  // decision rather than an oversight.
  //
  // Ruling A's GENERAL property -- that no state field, log line, rationale or
  // prompt string asserts owner death -- is an amended-acceptance bullet marked
  // "Pinned by test", and no such test exists. A first draft here scanned for
  // phrasings like "owner is dead" and flagged two sites: liveness.ts, whose
  // comment says no caller may RENDER the signals that way, and session.ts,
  // whose comment describes the hazard. Both are the rule being written down.
  //
  // A scan that fails when someone documents the prohibition punishes the
  // practice it exists to enforce, and the predictable response to it is to
  // weaken the check until it passes. Distinguishing an operator-visible string
  // from prose about strings needs a real design -- a tagged surface registry,
  // or rendering assertions per surface -- not a cleverer regex. Reported as an
  // open acceptance gap rather than papered over with a check that would be
  // wrong in both directions.
});
