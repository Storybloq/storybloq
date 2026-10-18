/**
 * T-536: the onboarding fixes from the attempt 5 Codex batch, pinned as exact
 * sentences. Each one closes a defect a real run showed: a paraphrased package
 * question, "use your judgement" read as approval, an inline review schema that
 * fails to load, a review claimed with no captured response, and a pending
 * tooling line written in prose.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ResolutionsSchema } from "../../src/core/setup-apply.js";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "skill");
const read = (name: string): string => readFileSync(join(SKILL_DIR, name), "utf-8");

// Review r1 #7: the engine takes the full 64-character revision; digest12 is for display only.
const REVISION_SENTENCE =
  "add `\"reviewRevision\": \"<revision>\"` to that answer, `<revision>` being the 64 hex characters of the `Revision:` line `setup-review status` printed for the amended packet. The 12-character digest in a status line is for display only, and setup-apply refuses it. After the owner's skip no review is needed.";

describe("setup-flow.md onboarding anchors (T-536)", () => {
  const flow = read("setup-flow.md");

  it("fixes the plain-text package prompt to the four exact lines", () => {
    expect(flow).toContain("**Without a structured question tool**, end the package with exactly these four lines, one per line, no blank line between them and nothing after them:\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details\n\nDo not paraphrase a label: the owner, a reviewer or an evaluation harness reads these exact labels. The message ends at `Inspect details`");
  });

  it("says what is and is not approval, and runs 1e only after it", () => {
    expect(flow).toContain('An unambiguous affirmative reply to this question ("yes", "approve", "go ahead", "Approve setup") is approval. An answer that delegates judgement, says no preference, or answers a different question is not: ask the same question again: the same probe and status lines, the two fixed lines, one blank line, then the four lines, nothing after them.');
    expect(flow).toContain("Everything below runs only after approval as defined in 1d.");
    expect(flow).not.toContain('Everything below runs only after "Approve setup".');
  });

  it("hands the review to the CLI: the gate first, the packet on stdin to run, the package lines only from status (T-536 stage 1)", () => {
    expect(flow).toContain("**Open the review gate first**, in your first turn, before any question: run `storybloq setup-review gate` as a shell call of its own and follow its output. Keep the setup id it prints.");
    expect(flow).toContain("`## Source requirements` (one `R<n>: <requirement> (source: <file>, <section>)` per line), `## Owner answers and decisions`, `## Existing-state evidence`, and `## Plan`");
    expect(flow).toContain("Run `storybloq setup-review run --setup <id> <<'STORYBLOQ_PACKET'`, then the packet, then a line `STORYBLOQ_PACKET`.");
    expect(flow).toContain("copy its first two lines into the package verbatim; a `Revision:` line after them is for a resolution (1e) and never goes in the package. Never write either line yourself and never state a review outcome anywhere else.");
    expect(flow).toContain("When it prints a failed, absent or unreadable line, the package cannot be shown: send the stop.");
    expect(flow).toContain("between two lines of its own: `Plan, revision <digest12>:` before it and `End of plan, revision <digest12>` after it");
    // Only a reviewed revision has markers: a skipped package shows the proposed Plan bare.
    expect(flow).toContain("**The Plan in the package.** With a completed or round-limit line, it is the `## Plan` section of the packet status was given");
    expect(flow).toContain("After the owner's skip no revision was reviewed: show the proposed Plan with no markers and no digest.");
    expect(flow).toContain("Then the Plan (1c2), marked when the status line names a revision:");
    expect(flow).not.toContain("Then the marked Plan (1c2)");
    expect(flow).toContain("run `storybloq setup-review status --setup <id> --skipped`, with nothing on standard input");
    expect(flow).toContain("`storybloq setup-review run --setup <id> --new-cycle --reason \"<the owner's words>\"` on the adjusted packet, then status.");
    // The agent-run reviewer paths and the agent-written lines are gone.
    for (const gone of ["command -v codex", "review_plan", "codex exec", "Review id: R<n>", "invocation R<n>", "What counts as a review"]) expect(flow).not.toContain(gone);
  });

  it("pins the check set 2 forms the harness parses (T-536 batch 2)", () => {
    expect(flow).toContain("`Review not rerun: <what changed> changes no ticket's scope, dependencies or responsibilities.`");
    expect(flow).toContain("State the level on one line, `Quality level: <level>`, naming exactly one of the three right after the colon; a reason may follow after a comma or period.");
    expect(flow).toContain('"Inspect details" shows what the user asks for, changes nothing in the plan, and re-asks the same question with the same status line; a change is an adjustment.');
    expect(flow).toContain("jest `**/*.{test,spec}.*` and `__tests__`");
    expect(flow).toContain("**A discovery turn ends with its question.** In plain text, the question is the last thing in the message");
    expect(flow).toContain("**Last check before sending the completion message.**");
  });

  it("pins the check set 3 gate-first and closing forms (T-536 batch 3)", () => {
    expect(flow).toContain("When it prints the stop, send the four lines below as your whole first turn, with no discovery question, draft or review; ask discovery questions only after the owner chooses Continue without independent review.");
    expect(flow).not.toContain("before drafting; do not draft or describe a review");
    expect(flow).toContain("The message ends at `Inspect details`: that line, with no trailing spaces, is the last line of every turn that shows the package");
    expect(flow).toContain("```\nYour answers shape the plan; creating it is your choice.\nNothing is written until you choose Approve setup.\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details\n```");
    expect(flow).toContain("**When no reviewer can run**, or a `setup-review` command ends with this stop, send it and nothing else");
    expect(flow).toContain("No supported reviewer is available to review this plan.\nHow should I proceed?\nRetry the review\nContinue without independent review");
    // An authorised skip is never asked again.
    expect(flow).toContain("later adjustments carry its lines and do not ask again.");
    // The gate comes before the plan is drafted.
    expect(flow.indexOf("**Open the review gate first**")).toBeLessThan(flow.indexOf("**Decompose the entire in-scope brief**"));
  });

  it("pins the check set 4 and 5 closing lines, reviewer paths, re-ask layout and CLI rule (T-536 batches 4 and 5)", () => {
    const fixed = "Nothing is written until you choose Approve setup.";
    const shape = "Your answers shape the plan; creating it is your choice.";
    // T2d, batch 5 A2: the two fixed lines in the example, a blank line below them; the skill is named nowhere in the package.
    expect(flow).toContain("Directly above the question line, with one blank line between them, put the two lines shown below, verbatim. Do not name or quote the setup skill or its rules in the package; name the governance files you propose as usual. Any other note goes above those lines, never below `Inspect details`, and no line ends in spaces:");
    const example = /```\n(Your answers shape[^`]*)```/.exec(flow)?.[1] ?? "";
    expect(example).toBe(`${shape}\n${fixed}\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details\n`);
    // Batch 5 A2: the explanatory sentences an agent quoted in its packages are gone from the skill.
    expect(flow).not.toContain("One approval of the setup package authorises all of it.");
    expect(flow).not.toContain("One approval covers everything listed.");
    expect(flow).not.toContain("Do not cite, quote or link this file in the package.");
    expect(example).not.toContain("setup-flow.md");
    expect(flow).not.toContain("A citation of this file, a reminder that nothing is written before approval");
    // Byte-review w4-a6, finding 3: the old order could read as blank line, fixed line, question.
    expect(flow).not.toContain("Above the question, after one blank line, is the line");
    // T-536 stage 1: the agent-started reviewer paths left the flow with the CLI-run reviewer.
    expect(flow).not.toContain("an independent agent, when the client can start one");
    expect(flow).not.toContain("without reading the review schema");
    // T4a: the re-ask names the probe and status lines, the fixed line, the blank line and nothing after.
    expect(flow).toContain("ask the same question again: the same probe and status lines, the two fixed lines, one blank line, then the four lines, nothing after them.");
    // T-538: one engine call writes the setup; the per-item create calls and their CLI fallback are gone.
    expect(flow).toContain("Never create, update or wire items with individual calls, never run `storybloq init`, and never write those files yourself.");
    expect(flow).toContain("**Apply it** in one shell call of its own: `storybloq setup-apply <<'STORYBLOQ_SETUP'`, then the JSON, then a line `STORYBLOQ_SETUP`");
    for (const gone of ["storybloq_ticket_create", "storybloq_phase_create", "Pass 1:", "storybloq config set-overrides", "Verify after write"]) expect(flow).not.toContain(gone);
  });

  it("the documented resolution, filled in, passes the engine's schema, and a digest12 does not (review r1 #7)", () => {
    const shape = /a JSON array of `(\{[^`]+\})`/.exec(flow)?.[1];
    const extra = /add `("reviewRevision": "<revision>")`/.exec(flow)?.[1];
    expect(shape).toBeDefined();
    expect(extra).toBeDefined();
    const packet = "## Source requirements\nR1: sign in (source: brief, goals)\n## Owner answers and decisions\nnone\n## Existing-state evidence\nnone\n## Plan\nTicket: Sign in\n";
    const revision = createHash("sha256").update(packet).digest("hex");
    const fill = (template: string, value: string) => template
      .replace("<the line's target>", "K2 (T-001)").replace("<the answer>", "accept-current").replace("<the owner's words>", "keep my title").replace("<revision>", value);
    const answer = (value: string) => JSON.parse(fill(`${shape!.slice(0, -1)}, ${extra!}}`, value)) as unknown;
    expect(ResolutionsSchema.safeParse([answer(revision)]).success).toBe(true);
    expect(ResolutionsSchema.safeParse([answer(revision.slice(0, 12))]).success).toBe(false);
  });

  it("routes each setup-apply exit code and the resume case (T-538)", () => {
    for (const line of [
      "   - `3`: interrupted. Run `storybloq setup-apply --resume --setup <id>`; a resume never duplicates anything.",
      "Send all the answers in one call, `storybloq setup-apply --setup <id> --resolve '<json>'`",
      REVISION_SENTENCE,
      "An `enable refused` stop: relay its text verbatim.",
      "Exit 5 never comes from setup-apply.",
      "Ask nothing: run `storybloq setup-apply --resume --setup <id>` and continue at 1e step 3.",
      "each checkpoint as `Checkpoint (<kind>, owner <label>): <title>`",
    ]) expect(flow).toContain(line);
  });

  it("copies the engine's report lines verbatim (T-538)", () => {
    expect(flow).toContain("Copy the report lines into the message verbatim, never retyped, merged or shortened");
    expect(flow).toContain("**Last check before sending the completion message.** Every `Pending:` line of the report is in the message itself, one per line.");
    expect(flow).not.toContain("Verification tooling to establish:");
  });

  it("lets a mode file's fixed closing lines override SKILL.md's prose rule for Codex", () => {
    expect(read("SKILL.md")).toContain("Where a mode file fixes a question's exact closing lines (setup-flow.md's setup package), use those lines verbatim instead.");
  });

  it("ships no setup review schema: the CLI holds the reviewer's schema (T-536 stage 1)", () => {
    expect(existsSync(join(SKILL_DIR, "setup-review-schema.json"))).toBe(false);
  });
});
