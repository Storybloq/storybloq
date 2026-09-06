/**
 * T-494 scope 4: skill-doc anchors for the rulings section.
 *
 * Following T-489 exactly, including the reason its anchors are LOCAL `as const`
 * arrays rather than exports from `src/`: an anchor set is a test fixture, and
 * shipping it in the CLI would put test data in the published package.
 *
 * A shared anchor constant does not by itself prevent a VACUOUS PASS. If the
 * section extractor returns an empty slice, every absence anchor passes over
 * nothing and every presence anchor fails for the wrong reason. So all three
 * anti-vacuity guards are here: the anchor arrays are asserted non-empty, the
 * heading is asserted to occur exactly once, and the extracted region is
 * asserted non-empty before any anchor is checked.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Sliced locally rather than imported from `test/bus/wake-doc-anchors.test.ts`.
 * Importing another TEST file re-runs its entire suite inside this one, which
 * doubles its runtime and attributes its failures to this file. The extractor
 * is small, and the duplication buys independence; its own behaviour is put
 * under test below so this file's anti-vacuity guarantee stands on its own.
 *
 * From `heading` to the next heading of EQUAL OR HIGHER level, so a parent
 * heading closing the section cannot swallow unrelated content.
 */
function extractSection(
  markdown: string,
  heading: string,
): { found: "one" | "none" | "many"; section: string } {
  const lines = markdown.split("\n");
  const level = /^(#{1,6})\s/.exec(heading)?.[1].length ?? 0;
  const indices = lines
    .map((line, i) => (line.trim() === heading ? i : -1))
    .filter((i) => i >= 0);
  if (indices.length === 0) return { found: "none", section: "" };
  if (indices.length > 1) return { found: "many", section: "" };

  const start = indices[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s/.exec(lines[i]!);
    if (match && match[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return { found: "one", section: lines.slice(start, end).join("\n") };
}

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "..", "..", "src", "skill", "SKILL.md");
const ORCHESTRATOR_PATH = join(here, "..", "..", "src", "skill", "orchestrator-mode.md");
const REVIEW_LENSES_PATH = join(here, "..", "..", "src", "skill", "review-lenses", "review-lenses.md");

const RULINGS_HEADING = "## Rulings";

/**
 * Presence anchors are behaviours a reader must be told. Absence anchors are
 * claims that would be false: the first would instruct the paste this whole
 * mechanism exists to replace, the second would overclaim what the gate proves.
 */
const RULINGS_ANCHORS = {
  presence: [
    "by CITATION, never by paste",
    "--cites",
    "carries the id and a one-line summary",
    "the CURRENT id",
    "refuses a plan that omits one",
    "checks the id is MENTIONED",
    // The claim that broke once already: the docs said lens reviews received
    // cited rulings while the MCP entry point passed none. Anchored to the
    // sentence that names WHERE a lens review gets its item from.
    "takes it from the session, or from `target`",
    "supersede EVERY copy",
    "one superseding ruling per copy",
  ],
  absence: ["paste the ruling", "proves the plan follows"],
} as const;

const ORCHESTRATOR_ANCHORS = {
  presence: ["A ruling the pen makes is RECORDED, not repeated"],
} as const;

/**
 * The manual review path is a separate document and a separate way to lose the
 * delivery: `/story review T-XXX` names an item but passes no session, so
 * without `target` in this example the lenses get no rulings. Anchored on the
 * JSON key and on the sentence that says what omitting it costs, because an
 * example is what an agent copies.
 */
const REVIEW_LENSES_ANCHORS = {
  presence: [
    '"target": "T-XXX"',
    "silent context loss",
    // The sessionless hold has no on-disk route, so the echo is the only one.
    "on a review WITHOUT one it is required",
  ],
} as const;

describe("T-494 skill doc: the extractor itself", () => {
  it("reports a missing heading rather than returning an empty slice that passes", () => {
    const out = extractSection("# Title\n\nbody\n", "## Nope");
    expect(out.found).toBe("none");
    expect(out.section).toBe("");
  });

  it("reports a DUPLICATED heading instead of silently taking the first", () => {
    expect(extractSection("## A\nfirst\n\n## A\nsecond\n", "## A").found).toBe("many");
  });

  it("ends the section at the next heading of EQUAL level", () => {
    const { section } = extractSection("## A\nkeep\n## B\ndrop\n", "## A");
    expect(section).toContain("keep");
    expect(section).not.toContain("drop");
  });

  it("ends the section at a HIGHER-level heading too, so a parent cannot swallow it", () => {
    const { section } = extractSection("## A\nkeep\n# Parent\ndrop\n", "## A");
    expect(section).toContain("keep");
    expect(section).not.toContain("drop");
  });

  it("does NOT end the section at a deeper heading", () => {
    const { section } = extractSection("## A\nkeep\n### Child\nalso keep\n# Parent\ndrop\n", "## A");
    expect(section).toContain("also keep");
    expect(section).not.toContain("drop");
  });

  it("PASSES when forbidden text exists OUTSIDE the section", () => {
    const { section } = extractSection("## A\nclean\n## Elsewhere\npaste the ruling\n", "## A");
    expect(section).not.toContain("paste the ruling");
  });
});

describe("T-494 skill doc: anchor sets are not empty", () => {
  it("has anchors to check, so an emptied constant fails loudly", () => {
    expect(RULINGS_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(RULINGS_ANCHORS.absence.length).toBeGreaterThan(0);
    expect(ORCHESTRATOR_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(REVIEW_LENSES_ANCHORS.presence.length).toBeGreaterThan(0);
  });
});

describe("T-494 skill doc: SKILL.md documents rulings", () => {
  it("contains EXACTLY ONE rulings heading", async () => {
    const md = await readFile(SKILL_PATH, "utf-8");
    expect(extractSection(md, RULINGS_HEADING).found).toBe("one");
  });

  it("extracts a NON-EMPTY rulings section before any anchor is checked", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), RULINGS_HEADING);
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section.split("\n").length).toBeGreaterThan(1);
  });

  it("carries every presence anchor INSIDE the rulings section", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), RULINGS_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of RULINGS_ANCHORS.presence) {
      expect(section).toContain(anchor);
    }
  });

  it("carries NO absence anchor inside the rulings section", async () => {
    const { section } = extractSection(await readFile(SKILL_PATH, "utf-8"), RULINGS_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of RULINGS_ANCHORS.absence) {
      expect(section).not.toContain(anchor);
    }
  });
});

describe("T-494 skill doc: orchestrator-mode.md says a ruling is recorded, not repeated", () => {
  it("carries the presence anchor", async () => {
    const md = await readFile(ORCHESTRATOR_PATH, "utf-8");
    expect(md.trim().length).toBeGreaterThan(0);
    for (const anchor of ORCHESTRATOR_ANCHORS.presence) {
      expect(md).toContain(anchor);
    }
  });
});

describe("T-494 skill doc: review-lenses.md tells the manual path to pass a target", () => {
  it("carries every presence anchor", async () => {
    const md = await readFile(REVIEW_LENSES_PATH, "utf-8");
    expect(md.trim().length).toBeGreaterThan(0);
    for (const anchor of REVIEW_LENSES_ANCHORS.presence) {
      expect(md).toContain(anchor);
    }
  });
});
