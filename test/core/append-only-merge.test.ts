import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMergeDriver } from "../../src/cli/commands/merge-driver.js";
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

describe("append-only-by-id: review fixes (null elements, unrepresentable content, non-array values)", () => {
  it("keeps a null added on ours", () => {
    const m = merge([], [null], []);
    expect(m.merged.receipts).toEqual([null]);
    expect(conflictsOf(m)).toEqual([]);
  });

  it("keeps a null added on theirs", () => {
    const m = merge([], [], [null]);
    expect(m.merged.receipts).toEqual([null]);
  });

  it("keeps a null after one side deleted it, with an opaque conflict", () => {
    const m = merge([null], [], [null]);
    expect(m.merged.receipts).toEqual([null]);
    expect(conflictsOf(m).map((c) => c.kind)).toEqual(["receipt-opaque"]);
  });

  it("refuses to merge two distinct objects holding non-finite numbers, never deduping them by String()", () => {
    const one = JSON.parse('{"kind":"test","n":1e999,"a":1}') as unknown;
    const two = JSON.parse('{"kind":"test","n":1e999,"b":2}') as unknown;
    expect(() => merge([], [one], [two])).toThrow(/cannot be compared|canonical/i);
  });

  it("the merge driver writes nothing and exits 2 on unrepresentable receipt content", () => {
    const dir = mkdtempSync(join(tmpdir(), "aom-driver-"));
    const t = (receipts: string) => `{"id":"T-001","title":"t","description":"","type":"task","status":"open","phase":"p1","order":10,"createdDate":"2026-01-01","blockedBy":[],"parentTicket":null,"completedDate":null,"receipts":${receipts}}\n`;
    const base = join(dir, "base.json");
    const ours = join(dir, "ours.json");
    const theirs = join(dir, "theirs.json");
    writeFileSync(base, t("[]"));
    const oursText = t('[{"kind":"test","n":1e999,"a":1}]');
    writeFileSync(ours, oursText);
    writeFileSync(theirs, t('[{"kind":"test","n":1e999,"b":2}]'));
    const before = [base, ours, theirs].map((f) => readFileSync(f, "utf-8"));
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(handleMergeDriver(base, ours, theirs, ".story/tickets/T-001.json")).toBe(2);
      expect([base, ours, theirs].map((f) => readFileSync(f, "utf-8"))).toEqual(before);
      expect(before[1]).toBe(oursText);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["null", null],
    ["an object", { not: "an array" }],
    ["a string", "receipts"],
  ])("refuses a one-sided replacement of the receipts array by %s, never yielding it", (_label, value) => {
    expect(() => threeWayMerge({ ...T, receipts: [A] }, { ...T, receipts: value }, { ...T, receipts: [A] }, "ticket")).toThrow(/receipts/);
    expect(() => threeWayMerge({ ...T, receipts: [A] }, { ...T, receipts: [A] }, { ...T, receipts: value }, "ticket")).toThrow(/receipts/);
  });

  it("the merge driver leaves the inputs alone when one side replaced receipts by null", () => {
    const dir = mkdtempSync(join(tmpdir(), "aom-driver-"));
    const t = (receipts: string) => `{"id":"T-001","title":"t","description":"","type":"task","status":"open","phase":"p1","order":10,"createdDate":"2026-01-01","blockedBy":[],"parentTicket":null,"completedDate":null,"receipts":${receipts}}\n`;
    const base = join(dir, "base.json");
    const ours = join(dir, "ours.json");
    const theirs = join(dir, "theirs.json");
    writeFileSync(base, t(JSON.stringify([A])));
    const oursText = t("null");
    writeFileSync(ours, oursText);
    writeFileSync(theirs, t(JSON.stringify([A])));
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(handleMergeDriver(base, ours, theirs, ".story/tickets/T-001.json")).toBe(2);
      expect(readFileSync(ours, "utf-8")).toBe(oursText);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the refused merge leaves a real repository's index untouched", () => {
  it("snapshots the index around the driver call on unrepresentable receipt content", () => {
    const repo = mkdtempSync(join(tmpdir(), "aom-index-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    try {
      run("init", "-q", "-b", "main");
      mkdirSync(join(repo, ".story", "tickets"), { recursive: true });
      const t = (receipts: string) => `{"id":"T-001","title":"t","description":"","type":"task","status":"open","phase":"p1","order":10,"createdDate":"2026-01-01","blockedBy":[],"parentTicket":null,"completedDate":null,"receipts":${receipts}}\n`;
      writeFileSync(join(repo, ".story", "tickets", "T-001.json"), t("[]"));
      run("add", "-A");
      run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
      const sides = join(repo, "..", `${repo.split("/").pop()}-sides`);
      mkdirSync(sides, { recursive: true });
      const base = join(sides, "base.json");
      const ours = join(sides, "ours.json");
      const theirs = join(sides, "theirs.json");
      writeFileSync(base, t("[]"));
      writeFileSync(ours, t('[{"kind":"test","n":1e999,"a":1}]'));
      writeFileSync(theirs, t('[{"kind":"test","n":1e999,"b":2}]'));
      const index = () => [run("ls-files", "-s", "--debug"), readFileSync(join(repo, ".git", "index")).toString("hex")];
      const indexBefore = index();
      const worktreeBefore = readFileSync(join(repo, ".story", "tickets", "T-001.json"), "utf-8");
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const cwd = process.cwd();
      try {
        process.chdir(repo);
        expect(handleMergeDriver(base, ours, theirs, ".story/tickets/T-001.json")).toBe(2);
      } finally {
        process.chdir(cwd);
        spy.mockRestore();
      }
      expect(index()).toEqual(indexBefore);
      expect(readFileSync(join(repo, ".story", "tickets", "T-001.json"), "utf-8")).toBe(worktreeBefore);
      rmSync(sides, { recursive: true, force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("review fixes, round 3: every merge refusal documents the way out", () => {
  it("names the inspect, repair, validate, add and continue-or-abort sequence", () => {
    const one = JSON.parse('{"kind":"test","n":1e999,"a":1}') as unknown;
    for (const run of [
      () => merge([], [one], []),
      () => threeWayMerge({ ...T, receipts: [A] }, { ...T, receipts: null }, { ...T, receipts: [A] }, "ticket"),
    ]) {
      expect(run).toThrow(/git show :1:<path>.*storybloq validate.*git add <path>.*git commit.*git merge --abort/);
    }
  });
});

