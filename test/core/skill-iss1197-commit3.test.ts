/**
 * ISS-1197 commit 3 part B: RED-first doc-anchor tests over the shipped
 * surfaces.
 *
 * Two things are pinned here.
 *
 * 1. The handover cadence ruling. One sentence, byte-identical, in the three
 *    files a driving session actually reads: SKILL.md (every session),
 *    duet-mode.md (a manager with workers) and orchestrator-mode.md (a wave).
 *    It carries five points that were previously only in the owner's ruling:
 *    the three moments a handover belongs at, that the pushed pressure line
 *    is advice rather than an instruction to write one per message, that a
 *    percentage is never a reason to stop, that one continue after a written
 *    handover is allowed, and that a worker above 90 percent is not asked for
 *    status.
 *
 * 2. The three-state enumerations. `compact-needed` shipped in commit 2 and
 *    every user-facing list of states still said there were three, and every
 *    description of the UserPromptSubmit hook line still said it fires only
 *    at `imperative`.
 *
 * Every assertion reads the real on-disk file (or the real exported
 * registry), so these fail against the pre-commit-3 text and pass after.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, MCP_TOOLS } from "../../src/cli/commands/reference.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SKILL_DIR = join(PROJECT_ROOT, "src", "skill");

const read = (name: string) => readFileSync(join(SKILL_DIR, name), "utf-8");

/**
 * ISS-1428: the cadence doctrine now has exactly one copy, in SKILL.md's
 * Context pressure paragraph; duet-mode.md and orchestrator-mode.md point at
 * it instead of repeating the old ruling sentence.
 */
export const CADENCE_DOCTRINE =
  "Doctrine: a handover is owed before auto-compaction, after a major item, and after a batch of issues or one big issue; one handover covers one compaction; never one per message; never stop at a percentage; one continue after a handover is allowed; no status demands to a worker above 90 percent; a duet worker writes on its own line.";
export const CADENCE_POINTER = "Handover cadence and the context notice: SKILL.md, Context pressure.";
const OLD_RULING_HEAD = "Cadence ruling: handover before auto-compaction";

const RULING_FILES = ["SKILL.md", "duet-mode.md", "orchestrator-mode.md"] as const;

/** The points, as a reader of the shipped SKILL.md must find them. */
const POINTS = [
  "before auto-compaction",
  "after a major item",
  "after a batch of issues or one big issue",
  "one handover covers one compaction",
  "never one per message",
  "never stop at a percentage",
  "one continue after a handover is allowed",
  "no status demands to a worker above 90 percent",
  "a duet worker writes on its own line",
];

describe("ISS-1197 commit 3 / ISS-1428: the handover cadence doctrine has one copy", () => {
  it("SKILL.md carries the doctrine verbatim, once, and every point", () => {
    // Read off the FILE, not the local constant: a constant asserted against
    // itself proves nothing about what shipped.
    const text = read("SKILL.md");
    expect(text.split(CADENCE_DOCTRINE).length).toBe(2);
    for (const point of POINTS) expect(text).toContain(point);
  });

  it.each(["duet-mode.md", "orchestrator-mode.md"])("%s points at SKILL.md instead of repeating the ruling", (file) => {
    expect(read(file)).toContain(CADENCE_POINTER);
  });

  it.each(RULING_FILES)("%s no longer carries the old ruling sentence", (file) => {
    expect(read(file)).not.toContain(OLD_RULING_HEAD);
  });

  it.each(RULING_FILES)("%s carries no em dash anywhere", (file) => {
    // Built from the codepoint so this test file itself stays em-dash free.
    expect(read(file)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("ISS-1197 commit 3: the state enumerations name compact-needed", () => {
  it("SKILL.md lists the fourth state with its threshold", () => {
    expect(read("SKILL.md")).toContain("`imperative` (90% and within 50k tokens of it, whichever later) or `compact-needed` (98%)");
  });

  it("SKILL.md (ISS-1428): one notice per band per compaction, on whichever surface carries it first; advisory is status-only", () => {
    const text = read("SKILL.md");
    expect(text).toContain("one notice per band per compaction to the caller's own live session, on whichever surface carries it first");
    expect(text).toContain("`advisory` is only a numbers line on status");
    expect(text).toContain("At `compact-needed` with no covering handover it says so once");
    expect(text).not.toContain("an `advisory`, `imperative` or `compact-needed` banner");
  });

  it("SKILL.md no longer promises the stamp drops the state to advisory", () => {
    // Untrue at compact-needed (commit 2), and the byte it frees pays for the
    // ruling above. Pinned so it cannot drift back in.
    expect(read("SKILL.md")).not.toContain("drops the state back to `advisory`");
  });

  it("autonomous-mode.md names compact-needed in the guide directive paragraph", () => {
    expect(read("autonomous-mode.md")).toContain("or `compact-needed` (98%)");
  });

  it("autonomous-mode.md (ISS-1428): the guide carries the shared notice, once per band per compaction, scoped by coverage", () => {
    const text = read("autonomous-mode.md");
    expect(text).toContain("the guide carries the context notice of SKILL.md, Context pressure, when no other surface carried it first");
    expect(text).toContain("At `imperative` the line asks for a handover via `storybloq_handover_create` unless one already covers this compaction");
    expect(text).toContain("At `compact-needed` it asks only when no handover covers the compaction");
    // The retired re-arm wording cannot drift back in.
    expect(text).not.toContain("does not repeat within 10 minutes");
    expect(text).not.toContain("stamp holds the state at `advisory` until the context grows another step");
  });

  it("setup-flow.md says the UserPromptSubmit hook injects the notice once per band per compaction", () => {
    expect(read("setup-flow.md")).toContain("injects the context notice once per band per compaction (imperative, compact-needed) and once after an uncovered compaction");
  });

  it("the MCP tool description enumerates four states", () => {
    const tools = readFileSync(join(PROJECT_ROOT, "src", "mcp", "tools.ts"), "utf-8");
    expect(tools).toContain("pressure state (ok/advisory/imperative/compact-needed)");
    expect(tools).not.toContain("pressure state (ok/advisory/imperative)");
  });

  it("the CLI reference entry enumerates four states", () => {
    const cmd = COMMANDS.find((c) => c.name === "session intel");
    expect(cmd?.description).toContain("(ok/advisory/imperative/compact-needed)");
  });

  it("the MCP reference entry enumerates four states", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "storybloq_session_intel");
    expect(tool?.description).toContain("(ok/advisory/imperative/compact-needed)");
  });
});
