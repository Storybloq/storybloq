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

/** The ruling, byte-identical wherever it appears. */
export const CADENCE_RULING =
  "Cadence ruling: handover before auto-compaction, after a major item completes, and after a batch of issues or one big issue resolves; the pushed line is advice, not one handover per message; never stop at a percentage; one continue after a handover is allowed; no status demands to a worker above 90 percent.";

const RULING_FILES = ["SKILL.md", "duet-mode.md", "orchestrator-mode.md"] as const;

/** The five points, as a reader of the shipped file must find them. */
const FIVE_POINTS = [
  "before auto-compaction",
  "after a major item completes",
  "after a batch of issues or one big issue resolves",
  "not one handover per message",
  "never stop at a percentage",
  "one continue after a handover is allowed",
  "no status demands to a worker above 90 percent",
];

describe("ISS-1197 commit 3: the handover cadence ruling reaches the skill text", () => {
  it.each(RULING_FILES)("%s carries the ruling verbatim", (file) => {
    expect(read(file)).toContain(CADENCE_RULING);
  });

  it.each(RULING_FILES)("%s names all five points", (file) => {
    // Read off the FILE, not the local constant: a constant asserted against
    // itself proves nothing about what shipped.
    const text = read(file);
    for (const point of FIVE_POINTS) expect(text).toContain(point);
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

  it("SKILL.md says the prompt line fires at imperative AND at compact-needed", () => {
    expect(read("SKILL.md")).toContain("at `imperative` and at `compact-needed` the next prompt carries");
  });

  it("SKILL.md names compact-needed in the banner list", () => {
    expect(read("SKILL.md")).toContain("an `advisory`, `imperative` or `compact-needed` banner");
  });

  it("SKILL.md no longer promises the stamp drops the state to advisory", () => {
    // Untrue at compact-needed (commit 2), and the byte it frees pays for the
    // ruling above. Pinned so it cannot drift back in.
    expect(read("SKILL.md")).not.toContain("drops the state back to `advisory`");
  });

  it("autonomous-mode.md names compact-needed in the guide directive paragraph", () => {
    expect(read("autonomous-mode.md")).toContain("or `compact-needed` (98%)");
  });

  it("autonomous-mode.md splits the two states: a handover at imperative, none at compact-needed", () => {
    const text = read("autonomous-mode.md");
    expect(text).toContain("At `imperative` the line asks for a handover");
    expect(text).toContain("At `compact-needed` the line says to write none");
    // The defect this replaces: one sentence that listed both states and then
    // told the reader to write a handover, which is the opposite instruction
    // at compact-needed. No sentence here may name compact-needed and ask for
    // one, under any verb. Scoped to this file on purpose: SKILL.md's own
    // enumeration legitimately names both states in one sentence.
    const conflated = text
      .split(/(?<=[.!?])\s/)
      .filter((s) => /compact-needed/.test(s) && /\b(write|record|create)\b[^.]*\bhandover/i.test(s));
    expect(conflated).toEqual([]);
  });

  it("autonomous-mode.md keeps the stamp doctrine, scoped to imperative", () => {
    // The only surviving copy in src/skill after SKILL.md paid for its ruling
    // with this clause; it is true at imperative and false at compact-needed.
    expect(read("autonomous-mode.md")).toContain("stamp holds the state at `advisory` until the context grows another step");
  });

  it("setup-flow.md says the UserPromptSubmit hook injects at both states", () => {
    expect(read("setup-flow.md")).toContain("injects one line only when pressure is imperative or compact-needed");
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
