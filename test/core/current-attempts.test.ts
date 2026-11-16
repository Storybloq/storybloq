/**
 * C-v4.1 commit 5, section 3.7: the one calculation of attempt order, and
 * 5.4's code classification. Ids, array order and timestamps never decide.
 */
import { describe, expect, it } from "vitest";
import { currentAttempts, ReceiptSchema, type Receipt } from "../../src/core/receipts.js";
import { classifyWork } from "../../src/core/proof.js";
import { BOARD, receipt } from "./receipt-fixture.js";

const id = (n: number): string => `rc-${String(n).padStart(16, "0")}`;
const r = (n: number, over: Record<string, unknown> = {}): Receipt => ReceiptSchema.parse(receipt({ id: id(n), ...over }));
const fail = { result: "fail", data: { passed: 1, failed: 1 } };
const forChild = (child: string) => (x: Receipt): boolean => (x.covers ?? [x.target]).includes(child);
const all = (): boolean => true;

describe("currentAttempts (3.7)", () => {
  it("is none when nothing is in scope", () => {
    expect(currentAttempts([], all)).toEqual({ outcome: "none", current: [] });
    expect(currentAttempts([r(1)], () => false)).toEqual({ outcome: "none", current: [] });
  });

  it("a pass superseded by a fail is failing", () => {
    const out = currentAttempts([r(1), r(2, { ...fail, supersedes: [id(1)] })], all);
    expect(out.outcome).toBe("failing");
    expect(out.current.map((x) => x.id)).toEqual([id(2)]);
  });

  it("a pass and a fail that do not supersede each other are concurrent, in either order", () => {
    const a = r(1);
    const b = r(2, fail);
    expect(currentAttempts([a, b], all).outcome).toBe("concurrent");
    expect(currentAttempts([b, a], all).outcome).toBe("concurrent");
  });

  it("a later pass superseding both gives pass", () => {
    const out = currentAttempts([r(1), r(2, fail), r(3, { supersedes: [id(1), id(2)] })], all);
    expect(out).toMatchObject({ outcome: "pass" });
    expect(out.current.map((x) => x.id)).toEqual([id(3)]);
  });

  it("only failures left is failing, an error counts as a failure", () => {
    expect(currentAttempts([r(1, fail), r(2, { result: "error", data: {} })], all).outcome).toBe("failing");
  });

  it("a superseder counts whatever its result: a failed superseder still removes the pass", () => {
    expect(currentAttempts([r(1), r(2, { ...fail, supersedes: [id(1)] })], all).current.map((x) => x.id)).toEqual([id(2)]);
  });

  it("a simulator receipt superseding a real pass removes the pass", () => {
    const real = r(1, { kind: "device", unitRef: `${BOARD}:T-001`, data: { deviceClass: "real" } });
    const sim = r(2, { kind: "device", unitRef: `${BOARD}:T-001`, data: { deviceClass: "simulator" }, supersedes: [id(1)] });
    expect(currentAttempts([real, sim], all).current.map((x) => x.id)).toEqual([id(2)]);
  });

  it("a superseder outside the scope removes nothing", () => {
    const a = r(1, { kind: "device", unitRef: `${BOARD}:T-001`, covers: [`${BOARD}:T-001`], data: { deviceClass: "real" } });
    const other = r(2, { kind: "device", unitRef: `${BOARD}:T-001`, covers: [`${BOARD}:T-002`], data: { deviceClass: "real" }, supersedes: [id(1)] });
    const out = currentAttempts([a, other], forChild(`${BOARD}:T-001`));
    expect(out).toMatchObject({ outcome: "pass" });
    expect(out.current.map((x) => x.id)).toEqual([id(1)]);
  });

  it("ids, array order and timestamps never decide", () => {
    const early = r(9, { recordedAt: "2020-01-01T00:00:00.000Z" });
    const late = r(1, { ...fail, recordedAt: "2030-01-01T00:00:00.000Z" });
    for (const set of [[early, late], [late, early]]) expect(currentAttempts(set, all).outcome).toBe("concurrent");
  });
});

describe("classifyWork (5.4)", () => {
  const none = new Set<string>();
  it("every ticket is code", () => {
    for (const type of ["task", "feature", "chore"]) expect(classifyWork({ type }, "ticket", `${BOARD}:T-001`, none)).toBe("code");
  });

  it("an issue is code with components and a source location, otherwise unknown", () => {
    expect(classifyWork({ components: ["cli"], location: ["src/cli/run.ts:12"] }, "issue", `${BOARD}:ISS-001`, none)).toBe("code");
    expect(classifyWork({ components: [], location: ["src/cli/run.ts"] }, "issue", `${BOARD}:ISS-001`, none)).toBe("unknown");
    expect(classifyWork({ components: ["cli"], location: [] }, "issue", `${BOARD}:ISS-001`, none)).toBe("unknown");
    expect(classifyWork({ components: ["cli"], location: [".story/config.json"] }, "issue", `${BOARD}:ISS-001`, none)).toBe("unknown");
  });

  it("non-code comes only from the configured list, by canonical ref", () => {
    const list = new Set([`${BOARD}:T-001`]);
    expect(classifyWork({ type: "task" }, "ticket", `${BOARD}:T-001`, list)).toBe("non-code");
    expect(classifyWork({ type: "task" }, "ticket", `${BOARD}:T-002`, list)).toBe("code");
  });
});
