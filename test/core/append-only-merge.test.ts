import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { canonicalJson } from "../../src/core/canonical-json.js";
import { legacyLandingId } from "../../src/core/legacy-landings.js";
import { readReceipts } from "../../src/core/receipts.js";
import { ConflictEntrySchema } from "../../src/models/types.js";
import { receipt } from "./receipt-fixture.js";

/** C-v4.1 3.6: `append-only-by-id` for receipts and landings; nothing is ever dropped. */

const T = { id: "T-001", title: "t", status: "open" };
const digest = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
const A = receipt({ id: "rc-aaaaaaaaaaaaaaaa" });
const B = receipt({ id: "rc-bbbbbbbbbbbbbbbb" });
const C = receipt({ id: "rc-cccccccccccccccc" });
const A2 = receipt({ id: "rc-aaaaaaaaaaaaaaaa", result: "fail", data: { passed: 1, failed: 1 } });
const NO_ID = { kind: "test", note: "no id here" };
const FUTURE = { id: "rc-ffffffffffffffff", v: 2, shape: "new" };

const merge = (b: unknown[] | undefined, o: unknown[] | undefined, t: unknown[] | undefined) =>
  threeWayMerge(
    b === undefined ? { ...T } : { ...T, receipts: b },
    o === undefined ? { ...T } : { ...T, receipts: o },
    t === undefined ? { ...T } : { ...T, receipts: t },
    "ticket",
  );

const conflictsOf = (m: ReturnType<typeof merge>) => (m.merged._conflicts as Record<string, unknown>[] | undefined) ?? [];

describe("append-only-by-id: receipts", () => {
  it("leaves an absent field absent on every side, never []", () => {
    const m = merge(undefined, undefined, undefined);
    expect(Object.prototype.hasOwnProperty.call(m.merged, "receipts")).toBe(false);
  });

  it("unions entries added on each side, ours first", () => {
    const m = merge([A], [A, B], [A, C]);
    expect(m.merged.receipts).toEqual([A, B, C]);
    expect(conflictsOf(m)).toEqual([]);
  });

  it("keeps an entry added on one side where the other side has no field", () => {
    const m = merge(undefined, [A], undefined);
    expect(m.merged.receipts).toEqual([A]);
    expect(conflictsOf(m)).toEqual([]);
  });

  it("keeps a base entry one side removed, and writes a receipt conflict (the early returns cannot drop it)", () => {
    // base == theirs, so the generic rule would take ours and lose B.
    const m = merge([A, B], [A], [A, B]);
    expect(m.merged.receipts).toEqual([A, B]);
    const [c] = conflictsOf(m);
    expect(c).toMatchObject({ kind: "receipt", field: "receipts", id: B.id, fieldPath: `/receipts/${B.id}` });
    expect(c!.base).toEqual([digest(B)]);
    expect(c!.ours).toEqual([]);
    expect(c!.theirs).toEqual([digest(B)]);
    expect(ConflictEntrySchema.safeParse(c).success).toBe(true);
  });

  it("keeps both bodies when the same id differs on the two sides, and the id reads conflicted", () => {
    const m = merge([], [A], [A2]);
    expect(m.merged.receipts).toEqual([A, A2]);
    const [c] = conflictsOf(m);
    expect(c).toMatchObject({ kind: "receipt", id: A.id, base: [], ours: [digest(A)], theirs: [digest(A2)] });
    const read = readReceipts(m.merged);
    expect(read.state === "ok" && read.entries.map((e) => e.state)).toEqual(["conflicted", "conflicted"]);
  });

  it("keeps both bodies when one side alters a base entry", () => {
    const m = merge([A], [A2], [A]);
    expect(m.merged.receipts).toEqual([A2, A]);
    expect(conflictsOf(m)).toHaveLength(1);
  });

  it("never counts a conflicted entry", () => {
    const m = merge([], [A], [A2]);
    const read = readReceipts(m.merged);
    expect(read.state === "ok" && read.entries.filter((e) => e.state === "ok")).toEqual([]);
  });

  it("carries opaque elements, unions them by digest and never deletes them", () => {
    const m = merge([NO_ID], [NO_ID, FUTURE], [NO_ID, 7]);
    expect(m.merged.receipts).toEqual([NO_ID, FUTURE, 7]);
    expect(conflictsOf(m)).toEqual([]);
  });

  it("keeps an opaque base element one side removed, with an oc- conflict id stable across clones", () => {
    const run = () => merge([NO_ID, A], [A], [NO_ID, A]);
    const first = run();
    expect(first.merged.receipts).toEqual([A, NO_ID]);
    const [c] = conflictsOf(first);
    expect(c).toMatchObject({ kind: "receipt-opaque", field: "receipts" });
    expect(String(c!.id)).toMatch(/^oc-[0-9a-f]{16}$/);
    const expectedId = `oc-${createHash("sha256").update(canonicalJson({ base: [digest(NO_ID)], ours: [], theirs: [digest(NO_ID)] })).digest("hex").slice(0, 16)}`;
    expect(c!.id).toBe(expectedId);
    expect(conflictsOf(run())[0]!.id).toBe(c!.id);
    expect(ConflictEntrySchema.safeParse(c).success).toBe(true);
  });

  it("is clean when all three sides carry the same both-kept bodies", () => {
    const m = merge([A, A2], [A, A2, B], [A, A2]);
    expect(m.merged.receipts).toEqual([A, A2, B]);
    expect(conflictsOf(m)).toEqual([]);
  });
});

describe("append-only-by-id: legacy landings, keyed by lm- id", () => {
  const L1 = { sha: "a".repeat(40), branch: "main", landedAt: "2026-01-01T00:00:00Z" };
  const L2 = { sha: "b".repeat(40), branch: "main", landedAt: "2026-01-02T00:00:00Z" };
  const L3 = { sha: "c".repeat(40), branch: "main", landedAt: "2026-01-03T00:00:00Z" };
  const mergeL = (b: unknown[], o: unknown[], t: unknown[]) =>
    threeWayMerge({ ...T, landings: b }, { ...T, landings: o }, { ...T, landings: t }, "ticket");

  it("unions landings from both sides", () => {
    expect(mergeL([L1], [L1, L2], [L1, L3]).merged.landings).toEqual([L1, L2, L3]);
  });

  it("keeps a landing one side removed, naming its lm- id", () => {
    const m = mergeL([L1, L2], [L1], [L1, L2]);
    expect(m.merged.landings).toEqual([L1, L2]);
    expect(conflictsOf(m as never)[0]).toMatchObject({ kind: "receipt", field: "landings", id: legacyLandingId(L2) });
  });
});
