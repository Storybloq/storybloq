/**
 * T-496 (pen ruling): file-path-to-byte-ceiling table for SKILL.md,
 * session-guard.md, and every mode file installed by setup-skill.ts's
 * `supportFiles` array.
 *
 * Ceilings are the measured post-split size of each file, rounded up to
 * the next 1,000 bytes. They pin against regrowth -- they are NOT design
 * targets. `setup-flow.md` is over budget today (ISS-1146); its ceiling is
 * its own measured size like every other file. This ticket does not
 * decide ISS-1146.
 *
 * The file list itself is read from the real `supportFiles` array in
 * setup-skill.ts, not a hand-duplicated copy, so a new mode file added
 * there with no matching ceiling row fails this test rather than silently
 * shipping unbudgeted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SKILL_DIR = join(PROJECT_ROOT, "src", "skill");
const SETUP_SKILL_TS_PATH = join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts");

function readSupportFilesArray(): string[] {
  const src = readFileSync(SETUP_SKILL_TS_PATH, "utf-8");
  const match = src.match(/const supportFiles = \[([^\]]*)\];/);
  if (!match) throw new Error("supportFiles array not found in setup-skill.ts");
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

const CEILINGS: Readonly<Record<string, number>> = {
  // 56,000: T-460 Leg C step 1 (Settings extraction to settings.md) dropped
  // SKILL.md to 55,231 measured bytes; rounded up to the next 1,000. Lowered
  // from the T-496-era 65,000 (64,399 measured then) to keep the ceiling
  // pinning tightly against regrowth rather than leaving slack an
  // accumulating edit could silently reoccupy. Measured, not estimated.
  // T-320 commit 3's step 1 wording (55,954 measured) stays under this
  // ceiling by keeping the field inventory in reference.md, not SKILL.md.
  // T-523 re-pins 56,000 -> 57,000 for the Step 2 capability digest. The
  // three bytes between 55,997 measured and the old 56,000 were ARITHMETIC,
  // not a budget: this table's rule is the measured size rounded up to the
  // next 1,000, and at 55,997 that rounding happened to land almost exactly
  // on the file. 57,000 is likewise a pin and not a target, so the next
  // person to land near it re-pins rather than compressing contract to fit.
  // This is a re-pin by the convention that created the row (setup-flow.md
  // and duet-mode.md above did the same), not a ratchet raise like the
  // deliberate one in tool-contract-cues.test.ts; the comment says which
  // kind it is because the two are different instruments.
  // The digest line was trimmed BEFORE this re-pin, to 184 bytes carrying
  // only the tool call and why a reader needs it: no compression reaches
  // three bytes, and a stub that named the tool and nothing else still
  // measured 56,102. Recorded so the next edit does not re-derive the trim
  // and then cut contract to stay under.
  // T-524 re-pins 57,000 -> 58,000 for the Step 2 term digest and the
  // Glossary section, and records both measurements: 56,182 before, 57,487 as
  // first written, 57,374 after cutting the two clauses in the new text that
  // were rationale rather than contract ("what you do with that is judgement",
  // and the sentence explaining WHY a thin entry warns instead of erroring),
  // then 57,400 once the Step 2 sentence named the cap as a number so
  // skill-glossary-anchors.test.ts could pin it against TERM_DIGEST_CAP, then
  // 57,426 once the Glossary section wrote its two MCP calls as a tool with a
  // parameter, as the rest of this file does, rather than in CLI flag syntax.
  // 57,426 is the floor for this addition; what remains is the advisory rule
  // itself (G-A), the digest's bound and its omitted-counts sentence, the
  // one-word-one-entry refusal, and the thin warning -- each of which is a
  // behaviour a reader would otherwise get wrong.
  // CONSIDERED AND REJECTED, recorded so the next edit does not re-derive it:
  // the routing table in "How to Handle Arguments" repeats "in the same
  // directory as this skill file; if not found, tell user to run `storybloq
  // setup --client all`" ten times, about 950 bytes, and hoisting it to one
  // line above the list would have paid for this whole addition. It is not
  // duplication to cut. That table is READ ONE ROW AT A TIME by an agent
  // routing a subcommand, and the per-row parenthetical is what makes a row
  // self-contained; hoisting it moves the recovery instruction somewhere the
  // reader of a single row has no reason to look. T-502 paying for its health
  // addition by trimming "two duplicated routing parentheticals" is not
  // precedent for this: two within a row is redundancy, one per row is the
  // pattern.
  // T-522 commit 2b (2026-09-22): the propose/accept/withdraw paragraph in Rulings; measured 58,595 bytes at the re-pin.
  "SKILL.md": 60000,
  // T-460 Leg C step 1: 10,194 measured, rounded up to 11,000. Raised to
  // 12,000 by T-501, which documents `autoCompactWindow` (the three Claude
  // Code layers, when an edit takes effect, and Codex having no equivalent)
  // here rather than in SKILL.md: this file is read only on `/story
  // settings`, so it is off the priming path SKILL.md's ceiling protects.
  // Raised to 17,000 by T-502, which adds the `/story health` section (the
  // five checks, the advice each one pins, and the `healthCheck` config
  // block): 15,841 measured, rounded up to the next 1,000 plus one step of
  // headroom. Same reasoning as the T-501 raise, and SKILL.md paid for its
  // own two-line health addition by trimming two duplicated routing
  // parentheticals rather than raising the 56,000 priming ceiling.
  // Raised to 18,000 by ISS-1222, which documents the sixth health check
  // (`hook-duplicates`: what it reads, how a row is identified, what
  // setup-skill keeps): 17,468 measured, rounded up to the next 1,000. Off
  // the priming path, same reasoning as the T-501 and T-502 raises.
  "settings.md": 18000,
  "session-guard.md": 41000,
  "setup-flow.md": 47000, // ISS-1146: already over a design target, ceiling only pins regrowth
  // ISS-950 raises this from 27,000 to 28,000 (27,458 measured at landing).
  // The addition is the coverage-only change request: an agent that does not
  // report `capReasons` has a coverage cap routed like a findings cap, and one
  // that clears a cap by relabelling a skip defeats the whole item. Both are
  // behaviours this file has to name, and the full basis table lives in
  // review-lenses.md rather than here, which is what keeps the addition to one
  // paragraph plus a pointer.
  // T-526: the "Context brief" section (tiers, the EXISTING line, the
  // governing-change gate and `brief --rebase`) added 1,618 bytes; measured
  // 29,076 at the re-pin, rounded up to the next 1,000.
  // T-527: the "Knowledge review" section (dispositions, maintenance commits,
  // knowledge_rebase, knowledge_diverged, where an accepted review shows) and
  // KNOWLEDGE_REVIEW in the pipeline line; measured 30,497 at the re-pin.
  "autonomous-mode.md": 31000,
  // T-502: the generated file grew past 35,000 when the `health` command and
  // the `storybloq_health` tool entered the registry (35,259 measured).
  // This file is generated by scripts/regen-reference.mts, so the ceiling
  // tracks the tool inventory rather than prose discipline; raised to 36,000.
  // T-320 commits 3 and 5 added the `status --compact` and `lesson digest
  // --limit/--select` inventories to the same file; with T-502's entries the
  // three together measure 36,415 at landing (2026-09-11), so 37,000.
  // ALREADY OVER at 37,169 before ISS-950 touched it, so this raise covers a
  // pre-existing overshoot as well as its own 143 bytes (the judge tool's
  // capReasons/coverageOnlyCap return, without which a coverage cap is routed
  // like a findings cap). 37,312 measured; 38,000 to leave the generated file
  // one step of headroom, since it grows with the tool registry rather than
  // with prose.
  // 38,340 measured at the 1.15 release gate (2026-09-15): the roster CLI and
  // storybloq_roster_get (T-507 commit B) and the bundled bridge in the health
  // docs (T-509) grew the generated inventory past 38,000. 39,000 leaves the
  // same one-step headroom as before.
  // 41,396 measured at T-523: the six `capability` CLI leaves and the six
  // storybloq_capability_* tools add 2,631 bytes to the generated inventory.
  // 42,000 by the same one-step rule, third application of it on this row.
  // Nothing was trimmed to fit and nothing could be: this file is emitted by
  // `scripts/regen-reference.mts` from COMMANDS/MCP_TOOLS, so its size is the
  // surface's size and hand-editing it would only be reverted by the next
  // regeneration. That is what makes this row a pin rather than a budget, and
  // it is a different instrument from the deliberate ratchet in
  // tool-contract-cues.test.ts, where the payload IS prose and a trim is real.
  // 43,410 measured at T-524: the seven `term` CLI leaves and the five
  // storybloq_term_* tools add 2,004 bytes to the generated inventory (41,406
  // at HEAD before the regeneration, measured, not derived). 44,000
  // by the same one-step rule, fourth application of it on this row, and
  // nothing was trimmed to fit for the same reason as every prior time: the
  // file is emitted from COMMANDS/MCP_TOOLS and a hand edit would be reverted
  // by the next regeneration.
  // T-522 commit 2b: three ruling leaves, narrative and lifecycle flags, three MCP tools; measured 45,827 bytes (generated file, regrowth pin).
  // T-526 commit 1 over T-530: brief, capability defer, term defer, the
  // --clear-pending flags and storybloq_context_brief; measured 47,265 bytes
  // on the merged tree (46,751 before T-530 landed). Generated file; 48,000
  // by the same one-step rule.
  // ISS-1303 / ISS-1305: the duet spawn entry documents the --model default
  // and the no-ledger --dir launch; 47,992 at HEAD before the regeneration,
  // 48,120 measured after. Generated file; 49,000 by the same one-step rule.
  // T-537 S5: nine `checkpoint` CLI leaves and six storybloq_checkpoint_*
  // tools, with resolve's ruling provenance flags; 48,470 at HEAD before the
  // regeneration, 51,057 measured after. Generated file; 52,000 by the same
  // one-step rule.
  "reference.md": 52000,
  "federation-setup.md": 14000,
  // Was 47000 (measured 46,936 before this issue). ISS-1240 adds the roster
  // pointer to the pen priming order: live seats come from
  // storybloq_roster_get / `roster list`, not a committed contacts.json.
  // 47,358 measured after that; 48,000 keeps the same one-step headroom,
  // per this table's own rule that a ceiling is the measured size rounded
  // up to the next 1,000 and pins regrowth rather than setting a target.
  // T-526: the EXISTING template line and the three enrichment lookups
  // added 614 bytes; measured 48,314 at the re-pin, rounded up.
  "orchestrator-mode.md": 49000,
  // Was 9000 (T-496 post-split measurement). The file was already at
  // 11,102 measured bytes at HEAD before this ticket touched it (confirmed
  // via `git show HEAD:.../duet-mode.md | wc -c`); ISS-1190's branch-seats
  // warning line adds another 314. Same convention as setup-flow.md above:
  // already over a design target, so the ceiling pins the current measured
  // size (rounded up) rather than staying a target this file no longer
  // meets. ISS-1146 is the tracked trim step.
  // N-131 (2026-09-22): the "Spawning a worker" section added ~1.2 KB; measured 13,174 bytes at the re-pin.
  // T-530 (2026-09-22): the section grew to cover the automatic handshake, the
  // federation --dir wording and --recover; 13,345 at HEAD before the ticket,
  // 15,249 measured after. 16,000 by the same one-step rule.
  "duet-mode.md": 16000,
  "triage-mode.md": 17000,
  "bus-mode.md": 31000,
  "session-guard-fallback.md": 117000,
  "review-contract-template.md": 5000,
};

describe("skill mode-budget ceilings (T-496)", () => {
  it("SKILL.md plus every real supportFiles entry has a recorded ceiling and stays under it", () => {
    const files = ["SKILL.md", ...readSupportFilesArray()];
    expect(files.length).toBeGreaterThan(1);
    for (const filename of files) {
      const ceiling = CEILINGS[filename];
      if (ceiling === undefined) {
        throw new Error(
          `${filename} is installed by setup-skill.ts's supportFiles array but has no ceiling row in CEILINGS -- add one before shipping`,
        );
      }
      const size = readFileSync(join(SKILL_DIR, filename)).length;
      expect(size, `${filename} (${size} bytes) exceeds its ${ceiling}-byte ceiling`).toBeLessThanOrEqual(ceiling);
    }
  });
});
