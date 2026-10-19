/**
 * ISS-1284: the capability half of the agent report shape, and the docs that
 * tell a reader how the inventory works.
 *
 * Built on T-524's pattern (`skill-glossary-anchors.test.ts`): local `as const`
 * anchor arrays, each asserted non-empty, each heading asserted to occur exactly
 * once, and each extracted region asserted non-empty before any anchor is
 * checked, so an extractor that returns nothing fails for the right reason.
 *
 * Anchors are scoped to the text that carries the contract, never the whole
 * file: a phrase that survives somewhere else in a 50 KB skill file proves
 * nothing about the paragraph an agent reads when it builds its report.
 *
 * The README example is PARSED through CapabilitySchema rather than matched as
 * text, so the documented entry shape cannot drift from the model.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilitySchema } from "../../src/models/capability.js";

/** From `heading` to the next heading of equal or higher level (copied, not imported, for T-494's reason). */
function extractSection(markdown: string, heading: string): { found: "one" | "none" | "many"; section: string } {
  const lines = markdown.split("\n");
  const level = /^(#{1,6})\s/.exec(heading)?.[1]?.length ?? 0;
  const indices = lines.map((line, i) => (line.trim() === heading ? i : -1)).filter((i) => i >= 0);
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

/** The single paragraph (one line in these files) that starts with `lead`. */
function paragraphStarting(markdown: string, lead: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith(lead));
}

/** From `start` up to (not including) `end`, each required to occur exactly once. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0 || text.indexOf(start, from + 1) >= 0) return "";
  const to = text.indexOf(end, from);
  return to < 0 ? "" : text.slice(from, to);
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const SKILL_PATH = join(ROOT, "src", "skill", "SKILL.md");
const ORCHESTRATOR_PATH = join(ROOT, "src", "skill", "orchestrator-mode.md");
const DUET_PATH = join(ROOT, "src", "skill", "duet-mode.md");
const README_PATH = join(ROOT, "README.md");

const PEN_FILES = "agents report candidates; the pen files them after verifying at HEAD";

/** SKILL.md: the consult rule, parallel to Rulings. */
const SKILL_ANCHORS = {
  presence: [
    "Consult it before claiming a line is missing",
    "before adding a capability that may already exist",
    "storybloq_capability_match",
    "storybloq_capability_get",
    "Agents report candidates; the pen files them after verifying at HEAD",
  ],
} as const;

/** orchestrator-mode.md: the RESULT schema paragraph names the field and its five subfields. */
const ORCHESTRATOR_LEAD = "**Script practicalities (dynamic-workflow clients).**";
const ORCHESTRATOR_ANCHORS = {
  presence: ["`followUps` array", "`terms` array", "`capabilities` array (each entry: name, summary, entryPoints, contract, evidence)", PEN_FILES],
} as const;

/** duet-mode.md: the same field inside Dispatch and collect, where a worker builds its result. */
const DUET_HEADING = "## Dispatch and collect";
const DUET_ANCHORS = {
  presence: ["`followUps`", "`terms`", "`capabilities` (name, summary, entryPoints, contract, evidence)", PEN_FILES],
} as const;

/** README: the four contract points the code enforces (effectiveStatus, the freshness diff, isStampable, blockedByNote). */
const README_START = "**Capability entry**";
const README_END = "\nEach record is its own file.";
const README_ANCHORS = {
  presence: [
    // stored versus effective
    "The stored status (`current` or `review`) is what the file says; the effective status is what every read reports",
    "when a nonblank `pendingNote` is set",
    "or when the check returns any result",
    // the checkpoint commit against HEAD
    "Freshness compares the tree of the checkpoint commit in `checkedAt` with HEAD's",
    "it never looks at uncommitted content",
    "`--skip-check` skips only that comparison",
    // the pen inspects before it stamps
    "The pen inspects the entry points and confirms the contract, then runs `storybloq capability check --stamp <id>`",
    // the stamp rules
    "Freshness findings are stampable",
    "a structural or incomplete result blocks the stamp",
    "unless `--clear-pending` comes with the stamp",
    "that flag bypasses no other check",
    "Agents report capability candidates; the pen files them after verifying at HEAD",
  ],
} as const;

describe("ISS-1284 anchors: the anchor sets are not empty", () => {
  it("has anchors to check, so an emptied constant fails loudly", () => {
    for (const set of [SKILL_ANCHORS, ORCHESTRATOR_ANCHORS, DUET_ANCHORS, README_ANCHORS]) expect(set.presence.length).toBeGreaterThan(0);
  });
});

describe("ISS-1284 C1: SKILL.md has a Capabilities section with the consult rule", () => {
  it("contains exactly one Capabilities heading, a non-empty section, and every anchor inside it", async () => {
    const found = extractSection(await readFile(SKILL_PATH, "utf-8"), "## Capabilities");
    expect(found.found).toBe("one");
    expect(found.section.split("\n").length).toBeGreaterThan(1);
    for (const anchor of SKILL_ANCHORS.presence) expect(found.section).toContain(anchor);
  });
});

describe("ISS-1284 C2: the orchestrator RESULT schema carries capabilities", () => {
  it("names the field, its five subfields and who files it, inside the RESULT schema paragraph", async () => {
    const paragraphs = paragraphStarting(await readFile(ORCHESTRATOR_PATH, "utf-8"), ORCHESTRATOR_LEAD);
    expect(paragraphs).toHaveLength(1);
    for (const anchor of ORCHESTRATOR_ANCHORS.presence) expect(paragraphs[0]).toContain(anchor);
  });
});

describe("ISS-1284 C3: the duet report carries capabilities", () => {
  it("names the field, its five subfields and who files it, inside Dispatch and collect", async () => {
    const found = extractSection(await readFile(DUET_PATH, "utf-8"), DUET_HEADING);
    expect(found.found).toBe("one");
    expect(found.section.split("\n").length).toBeGreaterThan(1);
    for (const anchor of DUET_ANCHORS.presence) expect(found.section).toContain(anchor);
  });
});

describe("ISS-1284 C4: README documents the capability entry", () => {
  async function region(): Promise<string> {
    return between(await readFile(README_PATH, "utf-8"), README_START, README_END);
  }

  it("its example parses as a capability, optional fields included", async () => {
    const text = await region();
    expect(text.length).toBeGreaterThan(0);
    const block = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(block).not.toBeNull();
    const parsed = CapabilitySchema.parse(JSON.parse(block![1]!));
    for (const field of ["example", "rulings", "items", "terms", "checkedAt", "surfaces"]) expect(parsed).toHaveProperty(field);
  });

  it("states stored versus effective status, the commit comparison, the pen's inspection and the stamp rules", async () => {
    const text = await region();
    expect(text.length).toBeGreaterThan(0);
    for (const anchor of README_ANCHORS.presence) expect(text).toContain(anchor);
  });
});
