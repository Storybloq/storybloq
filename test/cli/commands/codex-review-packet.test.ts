/**
 * ISS-1115 R1: the NATIVE codex route.
 *
 * WHY THIS FILE IS SEPARATE FROM THE STAGE TESTS. On the bridge and agent
 * routes the guide hands an INSTRUCTION to the implementing agent, which then
 * composes the backend request, so a stage test proves the agent was told and
 * not that the reviewer received anything. On this route the handoff is code we
 * own: `codex-review.ts` builds the prompt and pipes it to `codex exec`. So it
 * is tested where the code owns it, on the constructed prompt itself.
 *
 * THREE BLOCKS, ALL THREE NEEDED. This route was missed by three revisions of
 * the plan. It returns from both stages before the packet insertion point, so
 * it got no context; its output schema is `additionalProperties: false` with
 * six required keys, so a reviewer could not EMIT provenance; and
 * `normalizeFinding` rebuilt a fresh object, so provenance would not have
 * survived even if the schema had allowed it. Fixing any one alone changes
 * nothing, which is why the plan took all three or none.
 */
import { describe, it, expect } from "vitest";
import {
  planPrompt,
  codePrompt,
  normalizeFinding,
  schemaForKind,
  type CodexFinding,
} from "../../../src/cli/commands/codex-review.js";

describe("ISS-1115 R1: the native prompt carries the packet", () => {
  it("prefixes the context and keeps the reviewer instructions", () => {
    const context = "# Prior review history\nsomething a round decided";

    const plan = planPrompt("sess-1", context);
    const code = codePrompt("sess-1", context);

    for (const prompt of [plan, code]) {
      expect(prompt).toContain("something a round decided");
      // The packet goes BEFORE, so the reviewer reads the history and then the
      // instructions that tell it what to do with them.
      expect(prompt.indexOf(context)).toBe(0);
    }
    expect(plan).toContain("independent Storybloq plan reviewer");
    expect(code).toContain("independent Storybloq code reviewer");
  });

  it("stays callable, and unchanged, with no context", () => {
    // The exported builders are used elsewhere; adding a parameter must not
    // change what they produce when it is absent.
    expect(planPrompt("sess-1")).toBe(
      "You are an independent Storybloq plan reviewer."
      + " Read .story/sessions/sess-1/plan.md and any referenced files."
      + " Do not edit files."
      + " Review for correctness, scope, missing risks, feasibility, and testability."
      + " Return only JSON matching the provided schema."
      + " Use verdict approve, revise, or reject."
      + " If there are no blocking issues, return findings as an empty array.",
    );
    expect(codePrompt("sess-1")).not.toContain("\n");
  });
});

describe("ISS-1115 R1: the output schema admits provenance", () => {
  const findingProps = (kind: "plan" | "code") =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (schemaForKind(kind) as any).properties.findings.items;

  it("permits all four provenance keys under additionalProperties:false", () => {
    for (const kind of ["plan", "code"] as const) {
      const items = findingProps(kind);
      // The constraint that made this necessary: without the keys, a reviewer
      // asked for provenance would emit output the schema rejects.
      expect(items.additionalProperties).toBe(false);
      for (const key of ["origin", "originClass", "sinceRound", "dispositionReason"]) {
        expect(Object.keys(items.properties)).toContain(key);
      }
    }
  });

  it("does NOT let a reviewer set its own disposition", () => {
    // A reviewer REPORTS; dispositioning is a later decision by someone else.
    // Letting a reviewer mark its own finding `addressed` would hand it the
    // laundering route this item exists to close.
    for (const kind of ["plan", "code"] as const) {
      expect(Object.keys(findingProps(kind).properties)).not.toContain("disposition");
    }
  });

  it("keeps the provenance keys OPTIONAL, so an older reviewer still validates", () => {
    for (const kind of ["plan", "code"] as const) {
      const required = findingProps(kind).required as string[];
      for (const key of ["origin", "originClass", "sinceRound", "dispositionReason"]) {
        expect(required).not.toContain(key);
      }
    }
  });

  it("constrains the vocabulary it does admit", () => {
    const items = findingProps("code");
    expect(items.properties.origin.enum).toEqual(["introduced", "pre-existing"]);
    expect(items.properties.originClass.enum).toEqual([
      "new", "reintroduced", "unchanged", "introduced-by-fix",
    ]);
  });
});

describe("ISS-1115 R1: normalizeFinding preserves provenance", () => {
  const base: CodexFinding = {
    severity: "major", category: "correctness", description: "a real defect",
  };

  it("carries all four fields through normalization", () => {
    const out = normalizeFinding({
      ...base,
      origin: "pre-existing",
      originClass: "reintroduced",
      sinceRound: 2,
      dispositionReason: "owner-accepted-risk",
    }, 0) as Record<string, unknown>;

    expect(out.origin).toBe("pre-existing");
    expect(out.originClass).toBe("reintroduced");
    expect(out.sinceRound).toBe(2);
    expect(out.dispositionReason).toBe("owner-accepted-risk");
  });

  it("leaves an absent label ABSENT rather than inventing one", () => {
    // Absent and unrecognised are different claims (D3) and neither may be
    // fabricated. Defaulting to `new` here would silently clear a re-raise the
    // reviewer simply failed to label.
    const out = normalizeFinding(base, 0) as Record<string, unknown>;

    expect(out.originClass).toBeUndefined();
    expect(out.origin).toBeUndefined();
    expect(out.sinceRound).toBeUndefined();
    expect("originClass" in out).toBe(false);
  });

  it("still defaults disposition and still folds in the file citation", () => {
    // The positive control for the two above: normalization's existing
    // behaviour is unchanged by the additions.
    const out = normalizeFinding({ ...base, file: "src/x.ts", line: 4 }, 0) as Record<string, unknown>;

    expect(out.disposition).toBe("open");
    expect(out.id).toBe("codex-1");
    expect(out.file).toBe("src/x.ts");
    expect(out.description).toContain("src/x.ts:4:");
  });
});
