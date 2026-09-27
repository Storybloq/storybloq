/**
 * ISS-1282: the bridge review gate's rules live once, in autonomous-mode.md
 * (the guide's own loop); orchestrator-mode.md (a wave) and duet-mode.md (a
 * pen with workers) carry a byte-identical pointer to them, which keeps both
 * under their size ceilings. The guide refuses a round that breaks these
 * rules, so a session that never read them would only learn them from a refusal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..", "..", "src", "skill");

const read = (name: string) => readFileSync(join(SKILL_DIR, name), "utf-8");

export const BRIDGE_GATE_BLOCK =
  '**Bridge review gate (ISS-1282).** A codex-bridge round counts only when its receipt proves it: `tier: "max"`, never a model name; code by `base`/`head` range in a standalone clone, at most 300 changed lines each, chained per file from the item baseline to the working tree with no gaps or repeats; the summary opens `REVIEWED: <path or [range]> (~N changed lines)` (plan: `REVIEWED: plan.md (~N lines)`); report `reviewReceipts`, one per call, each with that call\'s `models[]` verbatim and `sessionId` (plan: also `planSha256`). A receipt is ATTESTED, not authenticated: its models, sessionId and planSha256 are a CLAIM asserted by the reporting agent, not a record the bridge issued. Observed must be Codex, or Gemini under the accepted ruling at `recipeOverrides.reviewGate.geminiRuling`.';

/** Where a wave or a duet pen reads about the gate: a pointer to the rules, which live once. */
export const BRIDGE_GATE_POINTER =
  "**Bridge review gate (ISS-1282).** A commissioned codex-bridge round follows the receipt rules in autonomous-mode.md (Bridge review gate); the guide refuses a round that breaks them.";

describe("ISS-1282 bridge review gate block", () => {
  it("autonomous-mode.md carries the block exactly once, byte-identical, and no pointer", () => {
    expect(read("autonomous-mode.md").split(BRIDGE_GATE_BLOCK).length - 1).toBe(1);
    expect(read("autonomous-mode.md")).not.toContain(BRIDGE_GATE_POINTER);
  });

  for (const file of ["orchestrator-mode.md", "duet-mode.md"]) {
    it(`${file} carries the pointer exactly once, byte-identical, and not the block`, () => {
      expect(read(file).split(BRIDGE_GATE_POINTER).length - 1).toBe(1);
      expect(read(file)).not.toContain(BRIDGE_GATE_BLOCK);
    });
  }

  it("carries the attestation caveat the guide states, verbatim", async () => {
    const { RECEIPT_ATTESTATION } = await import("../../src/autonomous/review-gate-receipt.js");
    expect(BRIDGE_GATE_BLOCK).toContain(RECEIPT_ATTESTATION);
  });

  it("names the same threshold the guide enforces", async () => {
    const { MAX_RANGE_LINES } = await import("../../src/autonomous/review-gate-receipt.js");
    expect(BRIDGE_GATE_BLOCK).toContain(`at most ${MAX_RANGE_LINES} changed lines`);
  });
});
