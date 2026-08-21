import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE TWIN PARITY GATE (T-469, ISS-1026).
 *
 * `deepMergeConfig` here and `OrderedJSON.deepMerging` in the Mac app are one
 * contract with two implementations, and which one runs is decided by BUILD
 * CONFIGURATION: the sandboxed App Store build writes config.json natively, the
 * Dev-ID build shells out to this CLI. A divergence is therefore invisible until
 * a user on one build gets a different file than a user on the other.
 *
 * Both sides run "the same table". That claim was true when the tables were
 * written and is worth exactly nothing afterwards, because the tables are
 * hand-transcribed twins in two languages that no compiler compares. The
 * realistic failure is not a logic bug -- both suites are green -- it is a row
 * added, renamed or edited on one side only, after which both suites stay green
 * while the tables quietly stop being the same table.
 *
 * So this reads BOTH files and compares them structurally: same row names, and
 * every `dst`, `patch` and `expected` equal as parsed JSON rather than as text,
 * so formatting and Swift's literal syntax do not matter but content does.
 *
 * It parses source rather than importing, because there is no runtime that can
 * hold both languages. That makes it brittle by nature, which is why a parse
 * that finds nothing FAILS rather than passing vacuously: a regex that silently
 * matched zero rows would otherwise report perfect parity forever.
 */

const here = resolve(fileURLToPath(import.meta.url), "..");
const tsTablePath = join(here, "config-merge.test.ts");
const swiftTablePath = resolve(here, "../../../macos/claudestoryTests/OrderedJSONDeepMergeTests.swift");

interface Row {
  name: string;
  dst: unknown;
  patch: unknown;
  expected: unknown;
}

function readTsTable(): Row[] {
  const src = readFileSync(tsTablePath, "utf-8");
  const start = src.indexOf("}> = [");
  const end = src.indexOf("\n];", start);
  expect(start, "could not locate the TS table literal").toBeGreaterThan(-1);
  expect(end, "could not locate the end of the TS table literal").toBeGreaterThan(start);
  // eslint-disable-next-line no-eval -- a literal from a file in this repo, at test time
  return eval(`(${src.slice(start + 5, end + 2)})`) as Row[];
}

/** Unwraps `#"..."#`, `"""..."""` and `"..."` Swift string literals. */
function unquoteSwift(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('#"') && t.endsWith('"#')) return t.slice(2, -2);
  if (t.startsWith('"""') && t.endsWith('"""')) return t.slice(3, -3);
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  throw new Error(`unrecognised Swift string literal: ${t.slice(0, 60)}`);
}

function readSwiftTable(): Row[] {
  const src = readFileSync(swiftTablePath, "utf-8");
  const start = src.indexOf("let sharedTable");
  expect(start, "could not locate the Swift table literal").toBeGreaterThan(-1);
  const block = `${src.slice(start, src.indexOf("\n]\n", start))}\n`;
  const re = /DeepMergeCase\(\s*name:\s*"([^"]*)",\s*dst:\s*([\s\S]*?),\s*patch:\s*([\s\S]*?),\s*expected:\s*([\s\S]*?)\s*\)\s*,\s*(?=DeepMergeCase\(|$)/g;
  const rows: Row[] = [];
  for (let m = re.exec(block); m !== null; m = re.exec(block)) {
    rows.push({
      name: m[1]!,
      dst: JSON.parse(unquoteSwift(m[2]!)),
      patch: JSON.parse(unquoteSwift(m[3]!)),
      expected: JSON.parse(unquoteSwift(m[4]!)),
    });
  }
  return rows;
}

/**
 * The Swift half does not exist in the public projection of this package
 * (`Storybloq/storybloq` carries `storybloq/` only), so there the gate is inert
 * by design rather than broken. In the workspace it always runs.
 */
const swiftPresent = existsSync(swiftTablePath);

describe.skipIf(!swiftPresent)("the shared merge table is genuinely shared", () => {
  it("has the same rows on both sides, with equal content", () => {
    const ts = readTsTable();
    const swift = readSwiftTable();

    // Vacuous-pass guard: source parsing that matched nothing would otherwise
    // report parity between two empty sets.
    expect(ts.length).toBeGreaterThan(10);
    expect(swift.length, "the Swift table parsed to fewer rows than the TS one").toBe(ts.length);

    expect(swift.map((r) => r.name).sort()).toEqual(ts.map((r) => r.name).sort());

    const byName = new Map(swift.map((r) => [r.name, r]));
    for (const row of ts) {
      const twin = byName.get(row.name)!;
      expect(twin.dst, `dst diverged for "${row.name}"`).toEqual(row.dst);
      expect(twin.patch, `patch diverged for "${row.name}"`).toEqual(row.patch);
      expect(twin.expected, `expected diverged for "${row.name}"`).toEqual(row.expected);
    }
  });
});

describe.skipIf(swiftPresent)("twin parity gate", () => {
  it("is inert without the Mac app sources, which is the published-package case", () => {
    expect(swiftPresent).toBe(false);
  });
});
