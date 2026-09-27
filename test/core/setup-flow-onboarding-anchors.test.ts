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
    expect(flow).toContain("**Without a structured question tool**, end the package with exactly these four lines, one per line, no blank line between them and nothing after them:\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details\n\nDo not paraphrase a label or add a citation or closing paragraph: the owner, a reviewer or an evaluation harness reads these exact labels.");
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

  it("marks the pending tooling line verbatim", () => {
    expect(flow).toContain('- one line per pending stage, verbatim in this form: "Verification tooling to establish: <stage>: <proposed command> (pending: <reason>)".');
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
