/**
 * T-536: the onboarding fixes from the attempt 5 Codex batch, pinned as exact
 * sentences. Each one closes a defect a real run showed: a paraphrased package
 * question, "use your judgement" read as approval, an inline review schema that
 * fails to load, a review claimed with no captured response, and a pending
 * tooling line written in prose.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "skill");
const read = (name: string): string => readFileSync(join(SKILL_DIR, name), "utf-8");

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

  it("gives the native review command with the shipped schema file and the plan on stdin", () => {
    expect(flow).toContain("`codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema '<skill dir>/setup-review-schema.json' - <<'STORYBLOQ_PLAN'`");
    expect(flow).toContain("The schema must be that file: a schema from `<(...)`, a here-document or `/dev/fd` fails to load in some clients' shells;");
  });

  it("counts a review only on a captured, completed response, and makes the unavailable stop mandatory otherwise", () => {
    expect(flow).toContain("A review counts only when a supported reviewer returned a completed response with a verdict and findings about the plan you supplied, captured in this session and quoted in the package.");
    expect(flow).toContain("When no supported reviewer returned such a response, the stop above is mandatory: never report a review as passed without one.");
  });

  it("pins the check set 2 forms the harness parses (T-536 batch 2)", () => {
    expect(flow).toContain("- `Independent review: <verdict>, invocation R<n>`: `<verdict>` is the captured response's `verdict` value exactly, and `R<n>` is the review id of the call that returned it.");
    expect(flow).toContain("- `Independent review: skipped at the owner's request`: only after the owner chose \"Continue without independent review\".");
    expect(flow).toContain("put `Review id: R<n>` as the first line of the plan you send");
    expect(flow).toContain("`Review not rerun: <what changed> changes no ticket's scope, dependencies or responsibilities.`");
    expect(flow).toContain("State the level on one line, `Quality level: <level>`, naming exactly one of the three right after the colon; a reason may follow after a comma or period.");
    expect(flow).toContain('"Inspect details" shows what the user asks for, changes nothing in the plan, and re-asks the same question with the same status line; a change is an adjustment.');
    expect(flow).toContain("jest `**/*.{test,spec}.*` and `__tests__`");
    expect(flow).toContain("**A discovery turn ends with its question.** In plain text, the question is the last thing in the message");
    expect(flow).toContain("**Last check before sending the completion message.**");
  });

  it("pins the check set 3 probe, id and closing forms (T-536 batch 3)", () => {
    expect(flow).toContain("**Probe the reviewers first**, in your first turn, before your first question. Run `command -v codex` as a shell call of its own, nothing else in that call, and keep exactly what it printed.");
    expect(flow).toContain("send the unavailable stop below now as your whole first turn, with no discovery question, wait, draft or review; ask discovery questions only after the owner chooses Continue without independent review.");
    expect(flow).not.toContain("before drafting; do not draft or describe a review");
    expect(flow).toContain("`Reviewer probe: `command -v codex` printed <path>`, where `<path>` is exactly what your most recent probe printed, or `Reviewer probe: `command -v codex` printed nothing`.");
    expect(flow).toContain("After a probe that printed nothing, a review result can only come from the `review_plan` tool or an agent you started after that probe");
    expect(flow).toContain("An id exists only once you send it as the first line of a reviewer call's input; a status line cites only an id you sent and whose response you captured, never an id for a review that did not run.");
    expect(flow).toContain("The message ends at `Inspect details`: that line, with no trailing spaces, is the last line of every turn that shows the package");
    expect(flow).toContain("```\nYour answers shape the plan; creating it is your choice.\nNothing is written until you choose Approve setup.\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details\n```");
    expect(flow).toContain("**When no reviewer can run**, or every reviewer call fails, send this stop and nothing else");
    expect(flow).toContain("No supported reviewer is available to review this plan.\nHow should I proceed?\nRetry the review\nContinue without independent review");
    // An authorised skip is never asked again, even after a probe that printed nothing.
    expect(flow).toContain("Unless the owner has already chosen Continue without independent review, if neither ran and returned a review, send the unavailable stop. After an authorised skip, continue with the probe line and the skip status line without asking again.");
    // The probe comes before the plan is drafted.
    expect(flow.indexOf("**Probe the reviewers first**")).toBeLessThan(flow.indexOf("**Decompose the entire in-scope brief**"));
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
    // T3a: the wait-on-nothing sentence once, inside reviewer 3; the probe paragraph names all three unavailable paths.
    const wait = "A wait with no agent started, or a wait that returned no message, is a wait on nothing, not a review.";
    expect(flow.split(wait).length - 1).toBe(1);
    expect(flow).toContain(`3. an independent agent, when the client can start one with a prompt you write and return its final message, either as the start call's own result or through a wait on that agent. ${wait} A wait tool alone cannot start one.`);
    expect(flow).toContain("When none of the three can run (the probe printed nothing, `review_plan` is not in your tool list after one exact-name discovery call, and you cannot start an agent), send the unavailable stop below now as your whole first turn,");
    expect(flow).not.toContain("without reading the review schema");
    // T4a: the re-ask names the probe and status lines, the fixed line, the blank line and nothing after.
    expect(flow).toContain("ask the same question again: the same probe and status lines, the two fixed lines, one blank line, then the four lines, nothing after them.");
    // A3: one storybloq command per shell call on the CLI fallback.
    expect(flow).toContain("and note that a client restart may be needed. Run one storybloq command per shell call, never through an interpreter script, a loop or a here-document, and check the result with `storybloq ticket list` or `storybloq phase list`, not a script.");
  });

  it("keeps the review schema byte for byte: no guard text in a reviewer-facing file (T-536 batch 4, T3b)", () => {
    expect(createHash("sha256").update(readFileSync(join(SKILL_DIR, "setup-review-schema.json"))).digest("hex")).toBe("c42e8fd8f386679aad7ee674df16d31640205914c2a0cd3a5f4ea1a4bd1ef853");
  });

  it("marks the pending tooling line verbatim", () => {
    expect(flow).toContain('- one line per pending stage, and per component when the project has several, verbatim in this form: "Verification tooling to establish: <stage>: <proposed command> (pending: <reason>)", or with a component "Verification tooling to establish: <stage> (<component>): <proposed command> (pending: <reason>)".');
  });

  it("lets a mode file's fixed closing lines override SKILL.md's prose rule for Codex", () => {
    expect(read("SKILL.md")).toContain("Where a mode file fixes a question's exact closing lines (setup-flow.md's setup package), use those lines verbatim instead.");
  });

  it("ships a review schema that parses and requires a verdict and findings", () => {
    const schema = JSON.parse(read("setup-review-schema.json")) as { type: string; required: string[]; additionalProperties: boolean };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["verdict", "findings"]);
    expect(schema.additionalProperties).toBe(false);
  });
});
