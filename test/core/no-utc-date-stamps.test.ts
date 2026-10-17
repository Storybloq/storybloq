/**
 * ISS-1383 backstop: no date-only stamp under src/ is taken by slicing an
 * ISO string, which yields the UTC date. Every `.slice(0, 10)` in src/ must
 * be a named exception below (a comparison or an array window, not a
 * stamp). The behaviour proof is local-date-stamps.test.ts; this scan only
 * stops a new slice-spelled stamp from landing unnoticed.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const SLICE = /\.slice\(\s*0\s*,\s*10\s*\)/g;

/** file (relative to src/, posix) -> exact trimmed line text -> reason. */
const EXCEPTIONS: ReadonlyArray<{ file: string; line: string; reason: string }> = [
  { file: "core/merge-driver.ts", line: "if (aDateOnly !== bDateOnly && a.slice(0, 10) === b.slice(0, 10)) return 0;", reason: "compares two stored values" },
  { file: "core/handover-parser.ts", line: "const dateA = a.slice(0, 10);", reason: "compares handover filename prefixes" },
  { file: "core/handover-parser.ts", line: "const dateB = b.slice(0, 10);", reason: "compares handover filename prefixes" },
  { file: "cli/commands/handover.ts", line: "const windowFilenames = filenames.slice(0, 10);", reason: "array window" },
  { file: "cli/commands/review-stats.ts", line: "for (const f of scan.failures.slice(0, 10)) {", reason: "array window" },
  { file: "autonomous/lens-harness/context-packager.ts", line: "return sigs.slice(0, 10); // Cap at 10 signatures", reason: "array cap" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every slice in `text`, matched against the whole text so a call spread over
 * several lines is found, reported as the trimmed line it starts on.
 */
function findSlices(text: string): Array<{ lineNumber: number; line: string }> {
  const lines = text.split("\n");
  return [...text.matchAll(SLICE)].map((m) => {
    const lineNumber = text.slice(0, m.index).split("\n").length;
    return { lineNumber, line: lines[lineNumber - 1]!.trim() };
  });
}

function sliceLines(): Array<{ file: string; line: string }> {
  const hits: Array<{ file: string; line: string }> = [];
  for (const full of walk(SRC)) {
    const file = relative(SRC, full).split(sep).join("/");
    for (const hit of findSlices(readFileSync(full, "utf-8"))) hits.push({ file, line: hit.line });
  }
  return hits;
}

describe("ISS-1383: no slice-spelled date stamps in src/", () => {
  it("the scanner finds a slice spread over several lines, on the line it starts", () => {
    const text = "const a = 1;\nconst d = new Date().toISOString().slice(\n  0,\n  10\n);\nconst w = xs.slice(0, 10);\n";
    expect(findSlices(text)).toEqual([
      { lineNumber: 2, line: "const d = new Date().toISOString().slice(" },
      { lineNumber: 6, line: "const w = xs.slice(0, 10);" },
    ]);
  });

  it("every .slice(0, 10) in src/ is a named exception", () => {
    const unexpected = sliceLines().filter((h) => !EXCEPTIONS.some((e) => e.file === h.file && e.line === h.line));
    expect(unexpected).toEqual([]);
  });

  it("every named exception still matches a line, so none can quietly widen the net", () => {
    const hits = sliceLines();
    const stale = EXCEPTIONS.filter((e) => !hits.some((h) => h.file === e.file && h.line === e.line));
    expect(stale).toEqual([]);
  });
});
