import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compile-time gate for ISS-886.
 *
 * The runtime tests can only exercise specs that compile. The design's central
 * safety claim is about the ones that must NOT: a "split" registration cannot
 * omit emptyAfterSplit, a "literal" one cannot declare it, and a positional
 * cannot declare requireValue. Those need tsc, not vitest, so this test runs tsc
 * over a committed fixture of `@ts-expect-error` cases and requires zero errors.
 *
 * Zero errors means every directive matched a real error. If a refactor collapses
 * the discriminated union, the expected error disappears, tsc reports the
 * directive as unused, and this fails.
 */

// One tsc program start dominates the runtime here.
vi.setConfig({ testTimeout: 120_000 });

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const fixtureDir = join(pkgRoot, "test", "cli", "fixtures");
const tsconfigPath = join(fixtureDir, "tsconfig.array-options.json");
const fixturePath = join(fixtureDir, "array-options-types.fixture.ts");
const tscPath = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

/** How many negative cases the fixture must carry. */
const EXPECTED_CASE_COUNT = 9;

/** Every negative case in the fixture, by its unique directive message. */
const EXPECTED_CASES = [
  "split without emptyAfterSplit must not compile on arrayOption",
  "split without emptyAfterSplit must not compile on applyArrayValueSpec",
  "split without emptyAfterSplit must not compile on arrayPositional",
  'emptyAfterSplit is meaningless under comma: "literal"',
  "requireValue cannot be declared on a positional",
  'emptyAfterSplit accepts only "reject" or "drop"',
  'trim accepts only "always", "segments", or "never"',
  "a registration spec must carry a describe",
  "an omitted trim has no safe default, so it cannot be optional",
] as const;

function typecheck(): { code: number; out: string } {
  try {
    const out = execFileSync("node", [tscPath, "-p", tsconfigPath], {
      cwd: pkgRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("array option spec types (ISS-886)", () => {
  it("typechecks the negative fixture with zero errors", () => {
    const result = typecheck();
    expect(result.code, result.out).toBe(0);
    // A passing tsc run prints nothing; anything on stdout is a diagnostic.
    expect(result.out.trim()).toBe("");
  });

  it("keeps the fixture non-vacuous: every claim has a directive asserting it", () => {
    // Guards the failure mode where someone "fixes" this suite by deleting
    // directives: a fixture with no @ts-expect-error also typechecks cleanly, and
    // would assert nothing at all.
    const source = readFileSync(fixturePath, "utf-8");

    // Anchored to directive LINES and pinned to an exact count. An unanchored
    // substring match also counts the prose mentions in the file's own doc
    // comment, which would let real cases be deleted while the count still held.
    const directives = source.match(/^[ \t]*\/\/[ \t]*@ts-expect-error\b/gm) ?? [];

    // The count is a literal, NOT EXPECTED_CASES.length: deleting a case together
    // with its entry here would keep those two in agreement and pass. Pinning both
    // against a literal means removing coverage requires editing a number that
    // says how many cases there are, which is deliberate rather than silent.
    expect(EXPECTED_CASES).toHaveLength(EXPECTED_CASE_COUNT);
    expect(directives).toHaveLength(EXPECTED_CASE_COUNT);

    // Every message is unique, so a deletion names itself instead of only lowering
    // a count.
    for (const claim of EXPECTED_CASES) {
      expect(source, `missing negative case: ${claim}`).toContain(claim);
    }
  });
});
