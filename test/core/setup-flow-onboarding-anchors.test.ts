/**
 * T-536: the onboarding fixes from the attempt 5 Codex batch, pinned as exact
 * sentences. Each one closes a defect a real run showed: a paraphrased package
 * question, "use your judgement" read as approval, an inline review schema that
 * fails to load, a review claimed with no captured response, and a pending
 * tooling line written in prose.
 */
import { describe, expect, it } from "vitest";
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
    expect(flow).toContain('An unambiguous affirmative reply to this question ("yes", "approve", "go ahead", "Approve setup") is approval. An answer that delegates judgement, says no preference, or answers a different question is not: ask the same question again with the four lines.');
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
    expect(flow).toContain("**Probe the reviewers first**, before drafting the plan. Run `command -v codex` as a shell call of its own, nothing else in that call, and keep exactly what it printed.");
    expect(flow).toContain("When none of the three can run, send the unavailable stop below now, before drafting; do not draft or describe a review.");
    expect(flow).toContain("`Reviewer probe: `command -v codex` printed <path>`, where `<path>` is exactly what your most recent probe printed, or `Reviewer probe: `command -v codex` printed nothing`.");
    expect(flow).toContain("After a probe that printed nothing, a review result can only come from the `review_plan` tool or an agent you started after that probe");
    expect(flow).toContain("An id exists only once you send it as the first line of a reviewer call's input; a status line cites only an id you sent and whose response you captured, never an id for a review that did not run.");
    expect(flow).toContain("The message ends at `Inspect details`: that line, with no trailing spaces, is the last line of every turn that shows the package");
    expect(flow).toContain("```\nThis setup follows setup-flow.md: \"One approval of the setup package authorises all of it.\"\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details\n```");
    expect(flow).toContain("**When no reviewer can run**, or every reviewer call fails, send this stop and nothing else");
    expect(flow).toContain("No supported reviewer is available to review this plan.\nHow should I proceed?\nRetry the review\nContinue without independent review");
    // An authorised skip is never asked again, even after a probe that printed nothing.
    expect(flow).toContain("Unless the owner has already chosen Continue without independent review, if neither ran and returned a review, send the unavailable stop. After an authorised skip, continue with the probe line and the skip status line without asking again.");
    // The probe comes before the plan is drafted.
    expect(flow.indexOf("**Probe the reviewers first**")).toBeLessThan(flow.indexOf("**Decompose the entire in-scope brief**"));
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
