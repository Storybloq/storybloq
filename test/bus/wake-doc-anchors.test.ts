/**
 * T-489 skill-doc anchors.
 *
 * A shared anchor constant does not by itself prevent a VACUOUS PASS: if the
 * section extractor returns an empty slice, every absence anchor passes over
 * nothing and every presence anchor fails for the wrong reason. So the extractor
 * is itself under test here, and each region is asserted NON-EMPTY before any
 * anchor runs.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "..", "..", "src", "skill", "bus-mode.md");

const WAKE_HEADING = "### The wake tier";

/**
 * Anchors scoped to the wake PROSE section.
 *
 * Presence anchors are behaviours a reader must be told. Absence anchors are the
 * pre-T-489 claims that would now be false.
 */
const WAKE_SECTION_ANCHORS = {
  presence: [
    "clientSessionName",
    "arming `bus poll --wait` at every idle boundary is a setup requirement",
    "the Stop hook path stays the only delivery during an active turn",
    "skipped:surface-unreachable",
  ],
  absence: ["no equivalent exists for Codex", "not shipped"],
} as const;

/**
 * Anchors scoped to the delivery TIER TABLE.
 *
 * Split out deliberately rather than asserted at file scope. The default-policy
 * statement belongs in the table (it is a property of the tier, alongside the
 * other tiers) and it genuinely lives there, so scoping it to the table keeps the
 * no-vacuous-pass guarantee that file-scope matching would give up.
 */
const WAKE_TABLE_ANCHORS = {
  presence: ["wakePolicy defaults to `never`", "wake (idle)"],
} as const;

/**
 * Slice a markdown section: from `heading` to the next heading of EQUAL OR HIGHER
 * level, so a parent heading closing the section cannot swallow unrelated content.
 */
export function extractSection(
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

/** The contiguous markdown table block containing `marker`. */
export function extractTableBlock(markdown: string, marker: string): string {
  const lines = markdown.split("\n");
  const hit = lines.findIndex((line) => line.startsWith("|") && line.includes(marker));
  if (hit < 0) return "";
  let start = hit;
  while (start > 0 && lines[start - 1]!.startsWith("|")) start--;
  let end = hit;
  while (end + 1 < lines.length && lines[end + 1]!.startsWith("|")) end++;
  return lines.slice(start, end + 1).join("\n");
}

async function skill(): Promise<string> {
  return await readFile(SKILL_PATH, "utf-8");
}

describe("T-489 skill doc: the extractor itself", () => {
  it("reports a missing heading rather than returning an empty slice that passes", () => {
    const out = extractSection("# Title\n\nbody\n", "### Nope");
    expect(out.found).toBe("none");
    expect(out.section).toBe("");
  });

  it("reports a DUPLICATED heading instead of silently taking the first", () => {
    const md = "### A\nfirst\n\n### A\nsecond\n";
    expect(extractSection(md, "### A").found).toBe("many");
  });

  it("ends the section at the next heading of EQUAL level", () => {
    const md = "### A\nkeep\n### B\ndrop\n";
    const { section } = extractSection(md, "### A");
    expect(section).toContain("keep");
    expect(section).not.toContain("drop");
  });

  it("ends the section at a HIGHER-level heading too, so a parent cannot swallow it", () => {
    const md = "### A\nkeep\n## Parent\ndrop\n";
    const { section } = extractSection(md, "### A");
    expect(section).toContain("keep");
    expect(section).not.toContain("drop");
  });

  it("does NOT end the section at a deeper heading", () => {
    const md = "### A\nkeep\n#### Child\nalso keep\n## Parent\ndrop\n";
    const { section } = extractSection(md, "### A");
    expect(section).toContain("also keep");
    expect(section).not.toContain("drop");
  });

  it("handles a heading that is last in the file", () => {
    const md = "## Intro\nx\n### A\nfinal content\n";
    const { found, section } = extractSection(md, "### A");
    expect(found).toBe("one");
    expect(section).toContain("final content");
  });

  it("PASSES when forbidden text exists OUTSIDE the section", () => {
    // Scoping is the whole point: prose elsewhere in the file must not fail a
    // section-scoped absence anchor.
    const md = "### A\nclean\n## Elsewhere\nnot shipped\n";
    const { section } = extractSection(md, "### A");
    expect(section).not.toContain("not shipped");
  });

  it("returns an empty block for a table marker that is absent", () => {
    expect(extractTableBlock("no tables here", "wake (idle)")).toBe("");
  });
});

describe("T-489 skill doc: anchor sets are not empty", () => {
  it("has anchors to check, so an emptied constant fails loudly", () => {
    // Without this, deleting the anchors would make every assertion below vacuous.
    expect(WAKE_SECTION_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(WAKE_SECTION_ANCHORS.absence.length).toBeGreaterThan(0);
    expect(WAKE_TABLE_ANCHORS.presence.length).toBeGreaterThan(0);
  });
});

describe("T-489 skill doc: bus-mode.md documents the wake tier", () => {
  it("contains EXACTLY ONE wake heading", async () => {
    expect(extractSection(await skill(), WAKE_HEADING).found).toBe("one");
  });

  it("extracts a NON-EMPTY wake section before any anchor is checked", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section.split("\n").length).toBeGreaterThan(1);
  });

  it("carries every presence anchor INSIDE the wake section", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of WAKE_SECTION_ANCHORS.presence) {
      expect(section).toContain(anchor);
    }
  });

  it("carries NO absence anchor inside the wake section", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of WAKE_SECTION_ANCHORS.absence) {
      expect(section).not.toContain(anchor);
    }
  });

  it("extracts a NON-EMPTY tier table and documents the wake row and its default", async () => {
    const table = extractTableBlock(await skill(), "wake (idle)");
    expect(table.trim().length).toBeGreaterThan(0);
    for (const anchor of WAKE_TABLE_ANCHORS.presence) {
      expect(table).toContain(anchor);
    }
  });

  it("states the tier is opt-in per endpoint via the documented flag", async () => {
    const table = extractTableBlock(await skill(), "wake (idle)");
    expect(table).toContain("bus setup --wake idle");
  });
});
