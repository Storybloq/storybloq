/**
 * T-538 S3a-2 commit 6: reading a run's evidence from recorded real outputs.
 * Every file under __fixtures__/t538-runner-output was recorded from the real
 * runner (vitest 3.2.4, jest 29.7.0, pytest 9.0.2, Django's test command,
 * go, cargo and flutter test) with CI=1, NO_COLOR=1 and FORCE_COLOR=0, with
 * scratch paths rewritten to /work; exits.json holds each run's exit code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceScanner, TAIL_BYTES, classifyEvidence, readJunit, type Evidence, type JunitCounts, type RunEnd, type StreamFacts, type TestRunner } from "../../src/core/setup-verify-parsers.js";

const FX = join(import.meta.dirname, "__fixtures__", "t538-runner-output");
const exits = JSON.parse(readFileSync(join(FX, "exits.json"), "utf-8")) as Record<string, number>;
const recorded = (name: string): Buffer => readFileSync(join(FX, `${name}.txt`));
const junitOf = (name: string): string | null => {
  try {
    return readFileSync(join(FX, `${name}.xml`), "utf-8");
  } catch {
    return null;
  }
};

function scan(chunks: readonly Buffer[]): StreamFacts {
  const s = new EvidenceScanner();
  for (const c of chunks) s.feed(c);
  return s.end();
}

function chunked(b: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, i + size));
  return out;
}

const ended = (exitCode: number | null, over: Partial<RunEnd> = {}): RunEnd => ({ exitCode, signal: null, timedOut: false, ...over });

function verdict(runner: TestRunner, name: string, over: Partial<RunEnd> = {}, chunkSize?: number): Evidence {
  const bytes = recorded(name);
  const facts = scan(chunkSize === undefined ? [bytes] : chunked(bytes, chunkSize));
  return classifyEvidence(runner, ended(exits[name]!, over), facts, junitOf(name), 600_000);
}

const ROWS: Array<[TestRunner, string, Evidence]> = [
  ["vitest", "vitest-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["vitest", "vitest-fail", { kind: "failed", reason: "the run reported a failure", executed: 2, failed: 1 }],
  ["vitest", "vitest-error", { kind: "failed", reason: "the run reported an error", executed: 2, failed: 0 }],
  ["vitest", "vitest-none", { kind: "failed", reason: "exited with code 1", executed: 0, failed: 0 }],
  ["vitest", "vitest-none-pass", { kind: "no-tests", executed: 0, failed: 0 }],
  ["vitest", "vitest-two-runs", { kind: "verified", executed: 4, failed: 0 }],
  ["jest", "jest-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["jest", "jest-fail", { kind: "failed", reason: "the run reported a failure", executed: 2, failed: 1 }],
  ["jest", "jest-suite", { kind: "failed", reason: "the run reported a failure", executed: 2, failed: 0 }],
  ["jest", "jest-none", { kind: "failed", reason: "exited with code 1", executed: 0, failed: 0 }],
  ["jest", "jest-none-pass", { kind: "no-tests", executed: 0, failed: 0 }],
  ["pytest", "pytest-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["pytest", "pytest-fail", { kind: "failed", reason: "the run reported a failure", executed: 3, failed: 2 }],
  ["pytest", "pytest-none", { kind: "failed", reason: "exited with code 5", executed: 0, failed: 0 }],
  ["django", "django-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["django", "django-fail", { kind: "failed", reason: "the run reported an error", executed: 3, failed: 2 }],
  ["django", "django-none", { kind: "no-tests", executed: 0, failed: 0 }],
  ["django", "unittest-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["django", "unittest-error", { kind: "failed", reason: "the run reported an error", executed: 1, failed: 1 }],
  ["django", "unittest-zero", { kind: "no-tests", executed: 0, failed: 0 }],
  ["go", "go-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["go", "go-fail", { kind: "failed", reason: "the run reported a failure", executed: 2, failed: 1 }],
  ["go", "go-build", { kind: "failed", reason: "the run reported an error", executed: 0, failed: 0 }],
  ["go", "go-none", { kind: "no-tests", executed: 0, failed: 0 }],
  ["cargo", "cargo-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["cargo", "cargo-fail", { kind: "failed", reason: "the run reported a failure", executed: 2, failed: 1 }],
  ["cargo", "cargo-none", { kind: "no-tests", executed: 0, failed: 0 }],
  ["flutter", "flutter-pass", { kind: "verified", executed: 2, failed: 0 }],
  ["flutter", "flutter-fail", { kind: "failed", reason: "the run reported a failure", executed: 2, failed: 1 }],
  ["flutter", "flutter-none", { kind: "failed", reason: "exited with code 79", executed: 0, failed: 0 }],
];

describe("recorded real outputs", () => {
  it.each(ROWS)("%s reads %s", (runner, name, expected) => {
    expect(verdict(runner, name)).toEqual(expected);
  });

  it.each(ROWS)("%s reads %s the same in 7-byte and 1-byte chunks", (runner, name, expected) => {
    expect(verdict(runner, name, {}, 7)).toEqual(expected);
    expect(verdict(runner, name, {}, 1)).toEqual(expected);
  });

  it("carriage-return progress lines are lines: flutter's verdict follows a CR, not a newline", () => {
    expect(recorded("flutter-pass").toString("utf-8")).toMatch(/\r00:06 \+2 ~1: All tests passed!/);
    expect(verdict("flutter", "flutter-pass").kind).toBe("verified");
  });

  it("CRLF line ends read the same", () => {
    const crlf = Buffer.from(recorded("vitest-pass").toString("utf-8").replace(/\n/g, "\r\n"));
    expect(classifyEvidence("vitest", ended(0), scan(chunked(crlf, 5)), null, 1)).toEqual({ kind: "verified", executed: 2, failed: 0 });
  });

  it("colour codes a runner prints anyway are stripped", () => {
    const coloured = Buffer.from("\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m2 passed\x1b[39m\x1b[22m\x1b[90m (2)\x1b[39m\n");
    expect(classifyEvidence("vitest", ended(0), scan([coloured]), null, 1)).toEqual({ kind: "verified", executed: 2, failed: 0 });
  });
});

describe("precedence", () => {
  it("a timeout or a kill comes before everything, even a passing summary", () => {
    expect(verdict("vitest", "vitest-pass", { timedOut: true, signal: "SIGKILL" })).toEqual({ kind: "failed", reason: "timed out after 600000 ms", executed: 2, failed: 0 });
    expect(verdict("cargo", "cargo-pass", { signal: "SIGTERM", exitCode: null })).toEqual({ kind: "failed", reason: "killed by SIGTERM", executed: 2, failed: 0 });
  });

  it("a reported failure comes before the exit code, even an exit of 0", () => {
    expect(verdict("go", "go-fail", { exitCode: 0 }).kind).toBe("failed");
    expect(verdict("pytest", "pytest-fail", { exitCode: 0 })).toMatchObject({ kind: "failed", reason: "the run reported a failure" });
  });

  it("pytest's failures are read from its report, not only its stream", () => {
    const facts = scan([Buffer.from("collected 3 items\n")]);
    expect(classifyEvidence("pytest", ended(0), facts, junitOf("pytest-fail"), 1)).toMatchObject({ kind: "failed", executed: 3, failed: 2 });
  });

  it("a nonzero exit with a passing summary is a failure", () => {
    expect(verdict("jest", "jest-pass", { exitCode: 2 })).toEqual({ kind: "failed", reason: "exited with code 2", executed: 2, failed: 0 });
  });

  it.each<[TestRunner, string]>([
    ["vitest", "jest-pass"], ["jest", "vitest-pass"], ["django", "cargo-pass"], ["go", "django-pass"], ["cargo", "go-pass"], ["flutter", "vitest-pass"],
  ])("%s with no summary of its own (%s's output) is unrecognized", (runner, name) => {
    expect(verdict(runner, name)).toMatchObject({ kind: "unrecognized" });
  });

  it("output with no summary at all is unrecognized for every runner", () => {
    for (const r of ["vitest", "jest", "django", "go", "cargo", "flutter"] as const) {
      expect(classifyEvidence(r, ended(0), scan([Buffer.from("all good\n")]), null, 1)).toEqual({ kind: "unrecognized", reason: `no ${r} summary in the output` });
    }
  });

  it("pytest without its report, or with one that does not read, is unrecognized", () => {
    expect(verdict("pytest", "pytest-pass", {}, undefined)).toMatchObject({ kind: "verified" });
    const facts = scan([recorded("pytest-pass")]);
    expect(classifyEvidence("pytest", ended(0), facts, null, 1)).toEqual({ kind: "unrecognized", reason: "pytest wrote no JUnit report" });
    expect(classifyEvidence("pytest", ended(0), facts, "<testsuites/>", 1)).toEqual({ kind: "unrecognized", reason: "pytest's JUnit report does not read" });
  });

  it.each<[TestRunner, string]>([
    ["vitest", "      Tests  2 passed | many skipped (3)\n"],
    ["vitest", "      Tests  2 passed\n"],
    ["jest", "Tests:       2 passed, 2\n"],
    ["django", "Ran 2 tests in 0.001s\n\nOK (skipped=one)\n"],
    ["django", "Ran 2 tests in 0.001s\n"],
    ["cargo", "test result: ok. 2 passed; lots failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"],
  ])("%s with an unreadable summary is unrecognized: %j", (runner, text) => {
    expect(classifyEvidence(runner, ended(0), scan([Buffer.from(text)]), null, 1)).toEqual({ kind: "unrecognized", reason: `a ${runner} summary does not read` });
  });

  it("summaries from two runners are unrecognized, whichever is the spec's", () => {
    const both = Buffer.concat([recorded("vitest-pass"), recorded("jest-pass")]);
    expect(classifyEvidence("vitest", ended(0), scan([both]), null, 1)).toEqual({ kind: "unrecognized", reason: "the output carries jest summaries as well as vitest's" });
    expect(classifyEvidence("jest", ended(0), scan([both]), null, 1)).toEqual({ kind: "unrecognized", reason: "the output carries vitest summaries as well as jest's" });
    const withPytest = Buffer.concat([recorded("pytest-pass"), recorded("cargo-pass")]);
    expect(classifyEvidence("pytest", ended(0), scan([withPytest]), junitOf("pytest-pass"), 1)).toMatchObject({ kind: "unrecognized", reason: "the output carries cargo summaries as well as pytest's" });
  });
});

describe("the whole stream, not the tail", () => {
  const noise = Buffer.from(("x".repeat(99) + "\n").repeat(Math.ceil((TAIL_BYTES * 2) / 100)));

  it("an early failure past 64 KiB of later output still fails the run", () => {
    const stream = Buffer.concat([recorded("go-fail"), noise, Buffer.from("ok  \texample.com/other\t0.1s\n")]);
    const facts = scan(chunked(stream, 4096));
    expect(facts.tail).not.toContain("--- FAIL");
    expect(Buffer.byteLength(facts.tail)).toBe(TAIL_BYTES);
    expect(classifyEvidence("go", ended(0), facts, null, 1)).toMatchObject({ kind: "failed", reason: "the run reported a failure" });
  });

  it("a second runner's summary past 64 KiB of later output is still seen", () => {
    const stream = Buffer.concat([recorded("jest-pass"), noise, recorded("vitest-pass")]);
    const facts = scan(chunked(stream, 4096));
    expect(facts.tail).not.toContain("Tests:");
    expect(classifyEvidence("vitest", ended(0), facts, null, 1)).toMatchObject({ kind: "unrecognized" });
  });

  it("counts summed across summaries survive the tail", () => {
    const stream = Buffer.concat([recorded("cargo-pass"), noise, recorded("cargo-pass")]);
    expect(classifyEvidence("cargo", ended(0), scan(chunked(stream, 4096)), null, 1)).toEqual({ kind: "verified", executed: 4, failed: 0 });
  });

  it("a character split across chunks keeps the tail intact", () => {
    const facts = scan(chunked(Buffer.from("✓ one\n      Tests  1 passed (1)\n"), 1));
    expect(facts.tail).toContain("✓ one");
  });
});

describe("an oversized line", () => {
  const pending = (sc: EvidenceScanner): number => (sc as unknown as { partial: string }).partial.length;

  it("holds at most 64 KiB of an unfinished line however many chunks arrive, and the run reads as unrecognized", () => {
    const sc = new EvidenceScanner();
    const block = Buffer.alloc(4096, "x");
    let most = 0;
    for (let i = 0; i < 400; i++) {
      sc.feed(block);
      most = Math.max(most, pending(sc));
    }
    expect(most).toBeLessThanOrEqual(TAIL_BYTES);
    // The line ends, and the summary after it is read as usual; the run still never verifies.
    sc.feed("\n      Tests  1 passed (1)\n");
    const facts = sc.end();
    expect(facts.oversizedLine).toBe(true);
    expect(facts.runners.get("vitest")).toMatchObject({ summaries: 1, executed: 1, failed: 0 });
    expect(classifyEvidence("vitest", ended(0), facts, null, 1)).toEqual({ kind: "unrecognized", reason: `a line of the output is longer than ${TAIL_BYTES} bytes, so part of it was never read` });
  });

  it("an oversized line still unfinished at the end is dropped, not read", () => {
    const facts = scan([Buffer.from("      Tests  1 passed (1)\n"), Buffer.alloc(TAIL_BYTES + 10, "y")]);
    expect(facts.oversizedLine).toBe(true);
    expect(classifyEvidence("vitest", ended(0), facts, null, 1).kind).toBe("unrecognized");
  });

  describe("a completed line over the bound is unreadable however its newline arrives", () => {
    const big = "w".repeat(TAIL_BYTES + 100);
    const summary = "      Tests  1 passed (1)\n";
    const unreadable = (chunks: string[]) => {
      const facts = scan(chunks.map((c) => Buffer.from(c)));
      expect(facts.oversizedLine).toBe(true);
      expect(classifyEvidence("vitest", ended(0), facts, null, 1)).toEqual({ kind: "unrecognized", reason: `a line of the output is longer than ${TAIL_BYTES} bytes, so part of it was never read` });
    };
    it("(a) in one feed with its newline", () => unreadable([`${big}\n`, summary]));
    it("(b) a buffered prefix under the bound, then the rest and the newline in the next feed", () => unreadable([big.slice(0, 40_000), `${big.slice(40_000)}\n`, summary]));
    it("(c) split before the newline, the newline alone in the last feed", () => unreadable([big.slice(0, 40_000), big.slice(40_000), "\n", summary]));
    it("(d) followed by a passing summary in the same feed", () => unreadable([`${big}\n${summary}`]));
  });

  it("a line just within the bound is read whole", () => {
    const facts = scan(chunked(Buffer.from(`${"z".repeat(TAIL_BYTES - 1)}\n      Tests  1 passed (1)\n`), 1000));
    expect(facts.oversizedLine).toBe(false);
    expect(classifyEvidence("vitest", ended(0), facts, null, 1)).toEqual({ kind: "verified", executed: 1, failed: 0 });
  });
});

describe("readJunit", () => {
  const whole = '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>';

  it("reads only a whole report: truncated, invalid or negative counts, a DTD, a second root or trailing bytes do not read", () => {
    expect(readJunit(whole)).toEqual({ executed: 2, failed: 0, errors: 0 });
    for (const [why, xml] of [
      ["truncated after the opening tags", '<?xml version="1.0"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" tests="2">'],
      ["truncated before the root closes", whole.replace("</testsuites>", "")],
      ["truncated inside a tag", whole.slice(0, whole.length - 5)],
      ["an invalid count", whole.replace('failures="0"', 'failures="invalid"')],
      ["a negative count", whole.replace('failures="0"', 'failures="-1"')],
      ["a negative tests count", whole.replace('tests="2"', 'tests="-2"')],
      ["an empty count", whole.replace('skipped="0"', 'skipped=""')],
      ["a DTD", `<!DOCTYPE x [<!ENTITY n "3">]>${whole}`],
      ["a second root", `${whole}<testsuite tests="1"/>`],
      ["bytes after the root", `${whole}<x>`],
      ["a mismatched close", whole.replace("</testsuite></testsuites>", "</testsuites></testsuite>")],
    ] as const) {
      expect(readJunit(xml), why).toBeNull();
    }
  });

  it("reads only a well-formed document: every element closed in order, either quote style, comments and CDATA never markup", () => {
    const passing = scan([recorded("pytest-pass")]);
    const rows: Array<[string, string, JunitCounts | null]> = [
      ["an unclosed child element", '<testsuite tests="1"><testcase></testsuite>', null],
      ["a mismatched child tag", '<testsuite tests="1"><testcase></testcases></testsuite>', null],
      ["a single-quoted count", `<testsuite tests="1" failures='1'/>`, { executed: 1, failed: 1, errors: 0 }],
      ["suite text inside a comment", '<testsuite tests="1"><!-- <testsuite tests="5" failures="3"/> --></testsuite>', { executed: 1, failed: 0, errors: 0 }],
      ["suite text inside CDATA", '<testsuite tests="1"><system-out><![CDATA[<testsuite tests="9" failures="9">]]></system-out></testsuite>', { executed: 1, failed: 0, errors: 0 }],
      ["a DOCTYPE", '<!DOCTYPE testsuite><testsuite tests="1"/>', null],
      ["content after the root", '<testsuite tests="1"/>trailing', null],
      ["two roots", '<testsuite tests="1"/><testsuite tests="1"/>', null],
    ];
    for (const [why, xml, counts] of rows) expect(readJunit(xml), why).toEqual(counts);
    expect(classifyEvidence("pytest", ended(0), passing, `<testsuite tests="1" failures='1'/>`, 1)).toMatchObject({ kind: "failed" });
    for (const name of ["pytest-pass", "pytest-fail", "pytest-none"]) expect(readJunit(junitOf(name)!), name).not.toBeNull();
  });

  it("reads only XML 1.0 characters: every reference and literal character in the Char ranges, and no ]]> in character data", () => {
    const passing = scan([recorded("pytest-pass")]);
    const suite = (out: string, name = "a") => `<testsuite name="${name}" tests="1"><system-out>${out}</system-out></testsuite>`;
    for (const [why, xml] of [
      ["a NUL reference", suite("&#0;")],
      ["a surrogate reference", suite("&#xD800;")],
      ["a reference past U+10FFFF", suite("&#x110000;")],
      ["a literal NUL", suite("a\u0000b")],
      ["a literal U+0001 in an attribute", suite("ok", "a\u0001")],
      ["]]> in character data", suite("a ]]> b")],
    ] as const) {
      expect(readJunit(xml), why).toBeNull();
      expect(classifyEvidence("pytest", ended(0), passing, xml, 1), why).toEqual({ kind: "unrecognized", reason: "pytest's JUnit report does not read" });
    }
    expect(readJunit(suite("&#x1F600;\t\u{1F600}", "tab\there"))).toEqual({ executed: 1, failed: 0, errors: 0 });
  });

  it("a missing optional count is zero, unlike an invalid one", () => {
    expect(readJunit('<testsuite name="a" tests="2"/>')).toEqual({ executed: 2, failed: 0, errors: 0 });
    expect(readJunit('<testsuite name="a" tests="2" skipped="x"/>')).toBeNull();
  });

  it("a report that does not read leaves a passing pytest run unrecognized", () => {
    const facts = scan([recorded("pytest-pass")]);
    for (const xml of ['<testsuites><testsuite tests="3" failures="0">', whole.replace('failures="0"', 'failures="invalid"'), whole.replace('failures="0"', 'failures="-1"')]) {
      expect(classifyEvidence("pytest", ended(0), facts, xml, 1)).toEqual({ kind: "unrecognized", reason: "pytest's JUnit report does not read" });
    }
  });

  it("sums every testsuite and leaves skipped tests out of the executed count", () => {
    const xml = '<testsuites><testsuite name="a" tests="3" failures="1" errors="1" skipped="1"></testsuite><testsuite name="b" tests="2" failures="0" errors="0"/></testsuites>';
    expect(readJunit(xml)).toEqual({ executed: 4, failed: 2, errors: 1 });
    expect(readJunit(readFileSync(join(FX, "pytest-none.xml"), "utf-8"))).toEqual({ executed: 0, failed: 0, errors: 0 });
    expect(readJunit('<testsuite name="a" failures="0"/>')).toBeNull();
  });
});
