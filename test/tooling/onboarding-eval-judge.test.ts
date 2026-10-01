/**
 * ISS-1348: the judge runner's pure mapping from a validated response to a JudgeResult, against attempt 10 run 1's
 * record and grading packet (test/fixtures/onboarding-eval-runs/judge-a10-run1/, byte copies of the stored run).
 */
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../scripts/continuity-lib.js";
import { judgeFromResponse, type JudgeResult, type JudgeRuling } from "../../scripts/onboarding-eval-lib.js";
import { finalizeRecord, packetMismatch } from "../../scripts/onboarding-eval-run.js";
import { preconditionProblem } from "../../scripts/onboarding-eval-judge.js";

const FIXTURE = resolve(__dirname, "..", "fixtures", "onboarding-eval-runs", "judge-a10-run1");
const recordBytes = readFileSync(join(FIXTURE, "record.json"));
const packetBytes = readFileSync(join(FIXTURE, "grading-packet.json"));
const record = JSON.parse(recordBytes.toString("utf-8")) as Record<string, unknown> & { semanticLines: string[]; bound: Record<string, number[]> };
const packetText = packetBytes.toString("utf-8");
const L = record.semanticLines;
const MODEL = "gpt-6-astra";

/** A passing ruling for line i, citing the first allowed candidate when the line is bound. */
const pass = (i: number): JudgeRuling => ({ index: i, echo: L[i]!, verdict: "pass", reason: `line ${i} holds`, citations: record.bound[L[i]!] ? [record.bound[L[i]!]![0]!] : [] });
const allPass = (): JudgeRuling[] => L.map((_, i) => pass(i));
const ok = (rulings: readonly JudgeRuling[]): JudgeResult => {
  const out = judgeFromResponse(record, packetBytes, rulings, MODEL);
  if (out.kind !== "ok") throw new Error(`expected a mapping, got ${out.kind}: ${out.reason}`);
  return out.result;
};
const verdictOf = (result: JudgeResult) => {
  const r = finalizeRecord(record, packetText, result);
  if (!r.ok) throw new Error(r.reason);
  return r.verdict;
};

describe("ISS-1348 judgeFromResponse: rulings mapped by canonical index", () => {
  it("the fixture is attempt 10 run 1, pending the judge, with 16 distinct lines and three bound lines", () => {
    expect(record.verdict).toBe("PENDING_SEMANTIC");
    expect(sha256(packetBytes)).toBe(record.packetSha256);
    expect(new Set(L).size).toBe(16);
    expect(Object.keys(record.bound)).toHaveLength(3);
  });

  it("P1: every line ruled pass, bound lines citing an allowed candidate: finalize gives PASS", () => {
    const result = ok(allPass());
    expect(result.lines.map((l) => l.line)).toEqual(L);
    expect(result.observedModel).toBe(MODEL);
    expect(verdictOf(result)).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("P2: valid rulings in a shuffled order map to canonical order and still PASS", () => {
    const shuffled = allPass().reverse();
    const result = ok(shuffled);
    expect(result.lines.map((l) => l.line)).toEqual(L);
    expect(verdictOf(result).verdict).toBe("PASS");
  });

  it("P3: indexes 0 and 1 carry each other's echo: both become mapping-error fails, never the echo text", () => {
    const rulings = allPass();
    rulings[0] = { ...rulings[0]!, echo: L[1]! };
    rulings[1] = { ...rulings[1]!, echo: L[0]! };
    const result = ok(rulings);
    expect(result.lines[0]).toEqual({ line: L[0], verdict: "fail", reason: "mapping error: the judge's echo differs from line 0", citations: [] });
    expect(result.lines[1]).toEqual({ line: L[1], verdict: "fail", reason: "mapping error: the judge's echo differs from line 1", citations: [] });
    expect(result.lines.map((l) => l.line)).toEqual(L);
    expect(verdictOf(result).verdict).toBe("FAIL");
  });

  it("P4: index 2's echo equals line 3: line 2 fails, line 3 keeps its own ruling", () => {
    const rulings = allPass();
    rulings[2] = { ...rulings[2]!, echo: L[3]! };
    const result = ok(rulings);
    expect(result.lines[2]).toEqual({ line: L[2], verdict: "fail", reason: "mapping error: the judge's echo differs from line 2", citations: [] });
    expect(result.lines[3]).toEqual({ line: L[3], verdict: "pass", reason: "line 3 holds", citations: [] });
    expect(result.lines.filter((l) => l.line === L[3])).toHaveLength(1);
  });

  it("P5: index 4 ruled pass then fail: every occurrence is invalid, a mapping-error fail", () => {
    const result = ok([...allPass(), { ...pass(4), verdict: "fail", reason: "second thoughts" }]);
    expect(result.lines[4]).toEqual({ line: L[4], verdict: "fail", reason: "mapping error: index 4 ruled 2 times", citations: [] });
    expect(verdictOf(result).verdict).toBe("FAIL");
  });

  it("P6: index 4 ruled fail then pass: still a mapping-error fail, the last ruling does not win", () => {
    const rulings = allPass();
    rulings[4] = { ...pass(4), verdict: "fail", reason: "first" };
    const result = ok([...rulings, pass(4)]);
    expect(result.lines[4]!.reason).toMatch(/^mapping error/);
    expect(result.lines[4]!.verdict).toBe("fail");
    expect(verdictOf(result).verdict).toBe("FAIL");
  });

  it("P7: index 5 not ruled: nothing is emitted for it and finalize reports it", () => {
    const result = ok(allPass().filter((r) => r.index !== 5));
    expect(result.lines.map((l) => l.line)).toEqual(L.filter((_, i) => i !== 5));
    expect(verdictOf(result)).toEqual({ verdict: "FAIL", reasons: [`the judge did not rule on: ${L[5]}`] });
  });

  it("P8: an otherwise complete response with an index outside 0..n-1 is invalid as a whole", () => {
    const out = judgeFromResponse(record, packetBytes, [...allPass(), { ...pass(0), index: 99 }], MODEL);
    expect(out.kind).toBe("schema-mapping");
    expect("result" in out).toBe(false);
    expect(judgeFromResponse(record, packetBytes, [...allPass(), { ...pass(0), index: -1 }], MODEL).kind).toBe("schema-mapping");
    expect(judgeFromResponse(record, packetBytes, [...allPass(), { ...pass(0), index: 16 }], MODEL).kind).toBe("schema-mapping");
  });

  it("P9: a bound line passed with no citation fails finalize", () => {
    const rulings = allPass();
    rulings[7] = { ...rulings[7]!, citations: [] };
    expect(verdictOf(ok(rulings)).reasons).toContain(`the judge passed without citing an invocation: ${L[7]}`);
  });

  it("P10: citations are copied whole: one allowed and one stray fails finalize on the stray", () => {
    const rulings = allPass();
    rulings[7] = { ...rulings[7]!, citations: [9, 7] };
    const result = ok(rulings);
    expect(result.lines[7]!.citations).toEqual([9, 7]);
    expect(verdictOf(result).reasons).toContain(`the judge cited 7, which are not candidates for: ${L[7]}`);
  });

  it("P11: packetSha256 is the sha256 of the packet bytes as read", () => {
    const result = ok(allPass());
    expect(result.packetSha256).toBe(sha256(packetBytes));
    expect(result.packetSha256).toBe(record.packetSha256);
  });
});

describe("ISS-1348 preconditions on the record directory", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const copy = (): string => {
    const d = mkdtempSync(join(tmpdir(), "judge-pre-"));
    dirs.push(d);
    cpSync(FIXTURE, d, { recursive: true });
    return d;
  };

  it("the fixture as stored passes the preconditions", () => {
    expect(preconditionProblem(copy())).toBeNull();
  });

  it("P12: a record whose semantic lines repeat one entry is refused, even when the packet agrees", () => {
    const d = copy();
    const packet = JSON.parse(packetText) as { semanticLines: string[] };
    const lines = [...L, L[3]!];
    packet.semanticLines = lines;
    const text = JSON.stringify(packet, null, 2);
    writeFileSync(join(d, "grading-packet.json"), text);
    writeFileSync(join(d, "record.json"), JSON.stringify({ ...record, semanticLines: lines, packetSha256: sha256(text) }, null, 2));
    expect(preconditionProblem(d)).toMatch(/semantic lines repeat/);
  });

  it("a record that is not pending the judge, or whose packet hash differs, is refused", () => {
    const d = copy();
    writeFileSync(join(d, "record.json"), JSON.stringify({ ...record, verdict: "PASS" }, null, 2));
    expect(preconditionProblem(d)).toMatch(/PENDING_SEMANTIC/);
    const e = copy();
    writeFileSync(join(e, "grading-packet.json"), `${packetText} `);
    expect(preconditionProblem(e)).toBe("the grading packet on disk does not match the hash this run recorded");
  });
});

describe("ISS-1348 packetMismatch: finalize's packet checks, shared with the runner, reasons unchanged", () => {
  const judge: JudgeResult = { packetSha256: sha256(packetBytes), observedModel: MODEL, lines: [] };
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["hash", record, `${packetText} `, "the grading packet on disk does not match the hash this run recorded"],
    ["no recorded hash", { ...record, packetSha256: undefined }, packetText, "the grading packet on disk does not match the hash this run recorded"],
    ["not JSON", { ...record, packetSha256: sha256("{") }, "{", "the grading packet is not JSON"],
    ["run id", { ...record, runId: "run-b" }, packetText, `the grading packet is for run ${String(record.runId)}, not run-b`],
    ["semantic lines", { ...record, semanticLines: ["other"] }, packetText, "the packet's semantic lines differ from the record's"],
  ];
  it.each(cases)("%s: finalizeRecord refuses with the reason packetMismatch gives, in the original order and wording", (_name, rec, text, reason) => {
    expect(packetMismatch(rec, text)).toBe(reason);
    expect(finalizeRecord(rec, text, judge)).toEqual({ ok: false, reason });
  });

  it("a matching record and packet give null, and finalize proceeds to a verdict", () => {
    expect(packetMismatch(record, packetText)).toBeNull();
    expect(finalizeRecord(record, packetText, judge).ok).toBe(true);
  });
});
