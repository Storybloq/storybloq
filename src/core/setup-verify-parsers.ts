/**
 * T-538 S3a-2: reading a test run's evidence. One streaming scanner reads the
 * whole merged stdout and stderr of the run, line by line across chunk splits
 * and carriage-return progress lines, and keeps sticky facts: a failure seen,
 * an error seen, and every runner summary seen with running counts. Only the
 * last 64 KiB is kept as text, for diagnostics and its digest; no verdict is
 * read from it. pytest's counts come from the JUnit XML the run wrote.
 *
 * The scanner knows every runner's summary, so a stream carrying summaries
 * from two runners is told apart from one carrying the spec runner's alone.
 *
 * A line still being assembled is held to the same 64 KiB. Past that the rest
 * of the line is discarded up to its delimiter and the run is marked as
 * carrying an oversized line, which can never be read as verified.
 */
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { TEST_RUNNERS } from "./setup-meta.js";

export type TestRunner = (typeof TEST_RUNNERS)[number];

export const TAIL_BYTES = 64 * 1024;

export interface RunnerSummary {
  /** How many summaries this runner printed; a second run of the same runner adds to the counts. */
  readonly summaries: number;
  readonly executed: number;
  readonly failed: number;
  /** A summary line of this runner whose counts could not be read. */
  readonly unparseable: boolean;
}

export interface StreamFacts {
  readonly failureSeen: boolean;
  readonly errorSeen: boolean;
  readonly runners: ReadonlyMap<TestRunner, RunnerSummary>;
  readonly tail: string;
  /** A line longer than TAIL_BYTES was seen; part of it was never read. */
  readonly oversizedLine: boolean;
}

interface Tally { summaries: number; executed: number; failed: number; unparseable: boolean }

// CSI and OSC sequences; NO_COLOR is set for the run, but a runner may ignore it.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** "2 passed | 1 skipped" or "1 failed, 2 passed, 3 total" into named counts; null when a part does not read. */
function namedCounts(text: string, sep: RegExp): Map<string, number> | null {
  const counts = new Map<string, number>();
  for (const part of text.split(sep)) {
    const m = /^(\d+) ([a-z]+(?: [a-z]+)*)$/.exec(part.trim());
    if (!m) return null;
    counts.set(m[2]!, (counts.get(m[2]!) ?? 0) + Number(m[1]));
  }
  return counts;
}

export class EvidenceScanner {
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";
  /** Inside an oversized line: everything up to its delimiter is dropped. */
  private discarding = false;
  private oversized = false;
  private tailBuf: Buffer = Buffer.alloc(0);
  private failure = false;
  private error = false;
  private readonly tallies = new Map<TestRunner, Tally>();
  /** unittest prints its verdict on the line after "Ran N tests"; that count waits here for it. */
  private ranPending: number | null = null;

  feed(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
    this.keepTail(bytes);
    this.scan(this.decoder.write(bytes));
  }

  end(): StreamFacts {
    this.scan(this.decoder.end());
    if (this.partial !== "" && !this.discarding) this.line(this.partial);
    this.partial = "";
    this.discarding = false;
    this.settleRan(null);
    return {
      failureSeen: this.failure,
      errorSeen: this.error,
      runners: new Map([...this.tallies].map(([r, t]) => [r, { ...t }])),
      tail: this.tailBuf.toString("utf-8"),
      oversizedLine: this.oversized,
    };
  }

  private keepTail(bytes: Buffer): void {
    const joined = Buffer.concat([this.tailBuf, bytes]);
    this.tailBuf = joined.length > TAIL_BYTES ? joined.subarray(joined.length - TAIL_BYTES) : joined;
  }

  private scan(text: string): void {
    let rest = text;
    if (this.discarding) {
      const at = rest.search(/[\r\n]/);
      if (at < 0) return;
      this.discarding = false;
      rest = rest.slice(at);
    }
    const parts = (this.partial + rest).split(/\r\n|\r|\n/);
    this.partial = parts.pop()!;
    for (const p of parts) {
      // A completed line is measured too: whether its delimiter arrived in the same feed must not decide the verdict.
      if (Buffer.byteLength(p, "utf-8") > TAIL_BYTES) {
        this.oversized = true;
        continue;
      }
      this.line(p);
    }
    if (Buffer.byteLength(this.partial, "utf-8") > TAIL_BYTES) {
      this.partial = "";
      this.discarding = true;
      this.oversized = true;
    }
  }

  private tally(r: TestRunner): Tally {
    let t = this.tallies.get(r);
    if (!t) this.tallies.set(r, (t = { summaries: 0, executed: 0, failed: 0, unparseable: false }));
    return t;
  }

  private summary(r: TestRunner, executed: number, failed: number): void {
    const t = this.tally(r);
    t.summaries += 1;
    t.executed += executed;
    t.failed += failed;
    if (failed > 0) this.failure = true;
  }

  private unreadable(r: TestRunner): void {
    const t = this.tally(r);
    t.summaries += 1;
    t.unparseable = true;
  }

  private settleRan(verdict: string | null): void {
    if (this.ranPending === null) return;
    const ran = this.ranPending;
    this.ranPending = null;
    const m = verdict === null ? null : /^(OK|FAILED)(?: \((.*)\))?$/.exec(verdict);
    if (!m) return this.unreadable("django");
    const counts = new Map<string, number>();
    for (const part of m[2] === undefined ? [] : m[2].split(", ")) {
      const kv = /^([a-z ]+)=(\d+)$/.exec(part);
      if (!kv) return this.unreadable("django");
      counts.set(kv[1]!, Number(kv[2]));
    }
    const failures = counts.get("failures") ?? 0;
    const errors = counts.get("errors") ?? 0;
    const skipped = counts.get("skipped") ?? 0;
    if (errors > 0) this.error = true;
    if (m[1] === "FAILED") this.failure = true;
    this.summary("django", ran - skipped, failures + errors);
  }

  private line(raw: string): void {
    const line = raw.replace(ANSI, "").trimEnd();
    if (this.ranPending !== null) {
      if (line.trim() === "") return;
      return this.settleRan(line.trim());
    }
    let m: RegExpExecArray | null;

    // vitest
    if ((m = /^\s*Tests {2,}(.+?)(?: \((\d+)\))?$/.exec(line))) {
      if (m[1] === "no tests") return this.summary("vitest", 0, 0);
      const c = m[2] === undefined ? null : namedCounts(m[1]!, / \| /);
      if (!c) return this.unreadable("vitest");
      return this.summary("vitest", (c.get("passed") ?? 0) + (c.get("failed") ?? 0), c.get("failed") ?? 0);
    }
    if (/^\s*Test Files {2,}.*\b[1-9]\d* failed\b/.test(line)) this.failure = true;
    if (/^\s*Errors {2,}[1-9]\d* errors?\b/.test(line)) { this.error = true; this.tally("vitest"); return; }
    if (/^No test files found, exiting with code \d+$/.test(line)) return this.summary("vitest", 0, 0);

    // jest
    if ((m = /^Tests:\s+(.+)$/.exec(line))) {
      const c = namedCounts(m[1]!, /, /);
      if (!c || !c.has("total")) return this.unreadable("jest");
      return this.summary("jest", (c.get("passed") ?? 0) + (c.get("failed") ?? 0), c.get("failed") ?? 0);
    }
    if (/^Test Suites:.*\b[1-9]\d* failed\b/.test(line)) this.failure = true;
    if (/^No tests found, exiting with code \d+$/.test(line)) return this.summary("jest", 0, 0);

    // pytest: the closing "== ... in 0.12s ==" line marks the runner; its counts come from the JUnit XML.
    if (/^=+ .*\bin [\d.]+s(?: \([^)]*\))? =+$/.test(line)) {
      if (/\b[1-9]\d* (failed|errors?)\b/.test(line)) this.failure = true;
      this.tally("pytest").summaries += 1;
      return;
    }

    // django (unittest's text runner)
    if ((m = /^Ran (\d+) tests? in [\d.]+s$/.exec(line))) {
      this.ranPending = Number(m[1]);
      return;
    }

    // go test -v: top-level results count; subtests are indented.
    if ((m = /^--- (PASS|FAIL|SKIP): /.exec(line))) {
      const t = this.tally("go");
      if (m[1] !== "SKIP") t.executed += 1;
      if (m[1] === "FAIL") { t.failed += 1; this.failure = true; }
      return;
    }
    if ((m = /^(ok|FAIL|\?)\s+\S+\s+(.*)$/.exec(line)) && /^(?:[\d.]+s|\(cached\)|\[no test files\]|\[build failed\]|\[setup failed\])/.test(m[2]!)) {
      this.tally("go").summaries += 1;
      if (m[1] === "FAIL") this.failure = true;
      if (/^\[(?:build|setup) failed\]/.test(m[2]!)) this.error = true;
      return;
    }
    if (/^panic: /.test(line)) this.error = true;

    // cargo test, once per test binary and once for the doc-tests
    if ((m = /^test result: (ok|FAILED)\. (.*)$/.exec(line))) {
      const c = namedCounts(m[2]!.replace(/; finished in .*$/, ""), /; /);
      if (!c || !c.has("passed") || !c.has("failed")) return this.unreadable("cargo");
      if (m[1] === "FAILED") this.failure = true;
      return this.summary("cargo", c.get("passed")! + c.get("failed")!, c.get("failed")!);
    }

    // flutter test: "00:06 +2 ~1 -1: ..." progress, closed by one of its verdicts.
    if ((m = /^\d{2}:\d{2} \+(\d+)(?: ~(\d+))?(?: -(\d+))?: (.*)$/.exec(line))) {
      const passed = Number(m[1]);
      const failed = m[3] === undefined ? 0 : Number(m[3]);
      if (failed > 0) this.failure = true;
      if (m[4] === "All tests passed!" || m[4] === "Some tests failed.") this.summary("flutter", passed + failed, failed);
      return;
    }
    if (line.trim() === "No tests ran.") this.summary("flutter", 0, 0);
  }
}

export interface JunitCounts { readonly executed: number; readonly failed: number; readonly errors: number }

const JUNIT_COUNTS = ["tests", "failures", "errors", "skipped"] as const;

const XML_NAME = /[A-Za-z_:][-\w.:]*/y;
const XML_SPACE = /[ \t\r\n]*/y;
/** Only the predefined entities and character references: nothing is declared, so nothing else is defined. */
const XML_TEXT_OK = /^[^&<]*(?:&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9A-Fa-f]+);[^&<]*)*$/;

/**
 * Every element of a whole, well-formed XML document, in document order, or
 * null. A strict minimal pass, never a general parser: one stack over every
 * element, attributes in either quote style with no duplicates, comments,
 * CDATA and processing instructions skipped as non-markup, any other
 * declaration (DOCTYPE, ENTITY) refused, only the predefined entities, and
 * exactly one root with nothing but whitespace or comments after it.
 */
function xmlElements(xml: string): Array<{ name: string; attrs: Map<string, string> }> | null {
  const doc = xml.startsWith("\uFEFF") ? xml.slice(1) : xml;
  const out: Array<{ name: string; attrs: Map<string, string> }> = [];
  const stack: string[] = [];
  let rooted = false;
  let i = 0;
  const name = (): string | null => {
    XML_NAME.lastIndex = i;
    const m = XML_NAME.exec(doc);
    if (!m) return null;
    i = XML_NAME.lastIndex;
    return m[0];
  };
  const space = (): number => {
    XML_SPACE.lastIndex = i;
    XML_SPACE.exec(doc);
    const n = XML_SPACE.lastIndex - i;
    i = XML_SPACE.lastIndex;
    return n;
  };
  while (i < doc.length) {
    const lt = doc.indexOf("<", i);
    const text = doc.slice(i, lt < 0 ? doc.length : lt);
    if (stack.length === 0 ? !/^[ \t\r\n]*$/.test(text) : !XML_TEXT_OK.test(text)) return null;
    if (lt < 0) break;
    i = lt;
    if (doc.startsWith("<!--", i)) {
      const close = doc.indexOf("-->", i + 4);
      if (close < 0 || doc.slice(i + 4, close).includes("--")) return null;
      i = close + 3;
      continue;
    }
    if (doc.startsWith("<![CDATA[", i)) {
      const close = doc.indexOf("]]>", i + 9);
      if (close < 0 || stack.length === 0) return null;
      i = close + 3;
      continue;
    }
    if (doc.startsWith("<?", i)) {
      const close = doc.indexOf("?>", i + 2);
      // A processing instruction is skipped inside the root or before it; after it, nothing but whitespace or comments.
      if (close < 0 || (rooted && stack.length === 0)) return null;
      i = close + 2;
      continue;
    }
    // Any other declaration, a DOCTYPE or an ENTITY above all, is refused: nothing is ever resolved.
    if (doc.startsWith("<!", i)) return null;
    if (doc.startsWith("</", i)) {
      i += 2;
      const n = name();
      space();
      if (n === null || doc[i] !== ">" || stack.pop() !== n) return null;
      i += 1;
      continue;
    }
    i += 1;
    const n = name();
    if (n === null) return null;
    if (stack.length === 0 && (rooted || (n !== "testsuite" && n !== "testsuites"))) return null;
    const attrs = new Map<string, string>();
    for (;;) {
      const gap = space();
      if (doc.startsWith("/>", i) || doc[i] === ">") break;
      const a = gap > 0 ? name() : null;
      if (a === null || attrs.has(a)) return null;
      space();
      if (doc[i] !== "=") return null;
      i += 1;
      space();
      const q = doc[i];
      if (q !== '"' && q !== "'") return null;
      const close = doc.indexOf(q, i + 1);
      if (close < 0) return null;
      const value = doc.slice(i + 1, close);
      if (!XML_TEXT_OK.test(value)) return null;
      attrs.set(a, value);
      i = close + 1;
    }
    out.push({ name: n, attrs });
    if (stack.length === 0) rooted = true;
    if (doc.startsWith("/>", i)) {
      i += 2;
    } else {
      i += 1;
      stack.push(n);
    }
  }
  return rooted && stack.length === 0 ? out : null;
}

/**
 * The counts in a JUnit XML report, summed over its testsuite elements; null
 * when the report does not read. It reads only when the whole document passes
 * the well-formedness pass above (entities are never resolved), and the counts
 * come only from real testsuite elements, never from text in a comment or
 * CDATA. Every count attribute present is a non-negative integer: a missing
 * optional count is zero, an invalid one makes the report unreadable, and
 * `tests` is required.
 */
export function readJunit(xml: string): JunitCounts | null {
  const elements = xmlElements(xml);
  if (elements === null) return null;
  let executed = 0;
  let failed = 0;
  let errors = 0;
  let suites = 0;
  for (const el of elements) {
    if (el.name !== "testsuite") continue;
    const counts = new Map<string, number>();
    for (const c of JUNIT_COUNTS) {
      const v = el.attrs.get(c);
      if (v === undefined) continue;
      if (!/^\d+$/.test(v)) return null;
      counts.set(c, Number(v));
    }
    const tests = counts.get("tests");
    if (tests === undefined) return null;
    const f = counts.get("failures") ?? 0;
    const e = counts.get("errors") ?? 0;
    suites += 1;
    executed += tests - (counts.get("skipped") ?? 0);
    failed += f + e;
    errors += e;
  }
  return suites === 0 ? null : { executed, failed, errors };
}

export interface RunEnd {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export type Evidence =
  | { readonly kind: "verified"; readonly executed: number; readonly failed: 0 }
  | { readonly kind: "failed"; readonly reason: string; readonly executed?: number; readonly failed?: number }
  | { readonly kind: "no-tests"; readonly executed: 0; readonly failed: 0 }
  | { readonly kind: "unrecognized"; readonly reason: string };

/**
 * The verdict, by precedence: a timeout or a kill; a reported failure or
 * error; a nonzero exit; no summary, an unreadable one, or summaries from two
 * runners (unrecognized); zero tests executed (no-tests); otherwise verified.
 * `junit` is pytest's report, null when the run wrote none or it did not read.
 */
export function classifyEvidence(runner: TestRunner, end: RunEnd, facts: StreamFacts, junit: string | null, timeoutMs: number): Evidence {
  const own = facts.runners.get(runner);
  const report = runner === "pytest" && junit !== null ? readJunit(junit) : null;
  const counts = runner === "pytest" ? (report === null ? undefined : { executed: report.executed, failed: report.failed }) : own && !own.unparseable ? { executed: own.executed, failed: own.failed } : undefined;

  if (end.timedOut) return { kind: "failed", reason: `timed out after ${timeoutMs} ms`, ...counts };
  if (end.signal !== null) return { kind: "failed", reason: `killed by ${end.signal}`, ...counts };
  if (facts.failureSeen || facts.errorSeen || (report !== null && report.failed > 0)) {
    return { kind: "failed", reason: facts.errorSeen || (report?.errors ?? 0) > 0 ? "the run reported an error" : "the run reported a failure", ...counts };
  }
  if (end.exitCode !== 0) return { kind: "failed", reason: `exited with code ${end.exitCode}`, ...counts };

  if (facts.oversizedLine) return { kind: "unrecognized", reason: `a line of the output is longer than ${TAIL_BYTES} bytes, so part of it was never read` };
  const others = [...facts.runners.keys()].filter((r) => r !== runner).sort();
  if (others.length > 0) return { kind: "unrecognized", reason: `the output carries ${others.join(" and ")} summaries as well as ${runner}'s` };
  if (runner === "pytest") {
    if (junit === null) return { kind: "unrecognized", reason: "pytest wrote no JUnit report" };
    if (report === null) return { kind: "unrecognized", reason: "pytest's JUnit report does not read" };
  } else if (own === undefined || own.summaries === 0) {
    return { kind: "unrecognized", reason: `no ${runner} summary in the output` };
  } else if (own.unparseable) {
    return { kind: "unrecognized", reason: `a ${runner} summary does not read` };
  }
  if (counts!.executed === 0) return { kind: "no-tests", executed: 0, failed: 0 };
  return { kind: "verified", executed: counts!.executed, failed: 0 };
}

/** The digest stored with a result: sha256 over the kept tail. */
export function tailDigest(tail: string): string {
  return createHash("sha256").update(tail, "utf-8").digest("hex");
}
