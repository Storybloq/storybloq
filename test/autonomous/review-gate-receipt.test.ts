/**
 * ISS-1282: a bridge review is a gate result only when its receipt proves it.
 *
 * Pure unit tests for the three assessors. The stage wiring (refusal before any
 * envelope, the refusal counter, the codexUnavailable cap) is covered in the
 * code-review and plan-review gate tests.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  assessBridgeModels,
  assessCodeReceipts,
  assessPlanReceipt,
  parseNumstatZ,
  tol,
  type NumstatEntry,
  type ReceiptProbe,
} from "../../src/autonomous/review-gate-receipt.js";

const astra = { provider: "codex", role: "review", requested: "max", resolved: "gpt-6-astra", observed: "gpt-6-astra", evidence: "runtime_session_record", selection: "requested" };
const gemini = { ...astra, provider: "gemini", resolved: "Gemini 3.1 Pro (High)", observed: "Gemini 3.1 Pro (High)" };
const NO_RULING = { geminiRulingAccepted: false };

describe("assessBridgeModels: rules (a) and (d)", () => {
  it("accepts a tier-max Codex review observed at runtime, and returns what ran", () => {
    expect(assessBridgeModels([astra], NO_RULING)).toEqual({ ok: true, value: { observed: [{ provider: "codex", model: "gpt-6-astra" }] } });
  });
  it("refuses a missing, empty or non-array receipt, and a list with no review entry", () => {
    expect(assessBridgeModels(undefined, NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/no bridge model receipt/) });
    expect(assessBridgeModels([], NO_RULING).ok).toBe(false);
    expect(assessBridgeModels("gpt-6-astra", NO_RULING).ok).toBe(false);
    expect(assessBridgeModels([astra, "x"], NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/array of objects/) });
    expect(assessBridgeModels([{ ...astra, role: "adjudicate" }], NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/no review entry/) });
  });
  it("refuses a null observed: a claimed model nothing saw is not a gate result", () => {
    expect(assessBridgeModels([{ ...astra, observed: null, evidence: "bridge_selection" }], NO_RULING))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/observed is null \(evidence bridge_selection\)/) });
  });
  it("refuses configured evidence even with an observed name", () => {
    expect(assessBridgeModels([{ ...astra, evidence: "bridge_selection" }], NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/not runtime_session_record/) });
  });
  it("refuses the silent downgrade: selection provider_default", () => {
    expect(assessBridgeModels([{ ...astra, selection: "provider_default", observed: "gpt-5.6-sol" }], NO_RULING))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/selection provider_default/) });
  });
  it("refuses a model-name request and a lower tier: only tier max is gate-grade", () => {
    expect(assessBridgeModels([{ ...astra, requested: "gpt-6-astra" }], NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/request tier max, never a model name/) });
    expect(assessBridgeModels([{ ...astra, requested: "balanced" }], NO_RULING).ok).toBe(false);
  });
  it("Gemini is gate-grade only under an accepted owner ruling, and is then disclosed", () => {
    expect(assessBridgeModels([gemini], NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/no accepted owner ruling/) });
    expect(assessBridgeModels([gemini], { geminiRulingAccepted: true })).toEqual({
      ok: true, value: { observed: [{ provider: "gemini", model: "Gemini 3.1 Pro (High)" }], disclosure: "gemini-under-owner-ruling" },
    });
  });
  it("refuses an unknown provider", () => {
    expect(assessBridgeModels([{ ...astra, provider: "other" }], NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/provider other/) });
  });
  it("deliberation: every review entry must pass, and both are reported", () => {
    expect(assessBridgeModels([astra, { ...gemini, selection: "provider_default" }], { geminiRulingAccepted: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/selection provider_default/) });
    const both = assessBridgeModels([astra, gemini], { geminiRulingAccepted: true });
    expect(both).toMatchObject({ ok: true, value: { observed: [{ provider: "codex" }, { provider: "gemini" }], disclosure: "gemini-under-owner-ruling" } });
  });
  it("an entry with no role counts as a review entry", () => {
    const { role: _role, ...noRole } = astra;
    expect(assessBridgeModels([noRole], NO_RULING).ok).toBe(true);
  });
});

describe("tol and parseNumstatZ", () => {
  it("tol is max(3, ceil(10%))", () => {
    expect([tol(0), tol(30), tol(31), tol(200)]).toEqual([3, 3, 4, 20]);
  });
  it("parses -z records exactly, including spaces, binaries and a file named range", () => {
    expect(parseNumstatZ("3\t1\ta b.ts\0-\t-\timg.png\0" + "2\t0\trange\0")).toEqual([
      { path: "a b.ts", added: 3, deleted: 1 }, { path: "img.png", added: null, deleted: null }, { path: "range", added: 2, deleted: 0 },
    ]);
    expect(parseNumstatZ("")).toEqual([]);
    expect(parseNumstatZ("garbage\0")).toBeNull();
  });
});

const z = (...e: [string, number | null, number | null][]): string => e.map(([p, a, d]) => `${a ?? "-"}\t${d ?? "-"}\t${p}\0`).join("");
const item = (...e: [string, number | null, number | null][]): NumstatEntry[] => e.map(([path, added, deleted]) => ({ path, added, deleted }));

/**
 * A fake repository: a path's tree entry at a commit is `<rev>:<path>` unless
 * `blobs` says otherwise (null = absent), and the working tree holds what h1
 * holds. So b1..h1 is, by default, exactly the item against baseline b1.
 */
function probe(ranges: Record<string, string>, over: Partial<ReceiptProbe> = {}, blobs: Record<string, string | null> = {}): ReceiptProbe & { calls: string[][] } {
  const calls: string[][] = [];
  const blob = (rev: string, path: string): string | null => (`${rev}:${path}` in blobs ? blobs[`${rev}:${path}`]! : `${rev}:${path}`);
  return {
    calls,
    isDir: () => true,
    inWorkTree: async () => true,
    entryAt: async (_cwd, rev, path) => blob(rev, path),
    workEntry: async (_root, path) => blob("h1", path),
    numstat: async (cwd, base, head) => {
      calls.push([cwd, base, head]);
      const out = ranges[`${base}..${head}`];
      if (out === undefined) throw new Error(`fatal: bad revision '${base}'\nmore`);
      return out;
    },
    ...over,
  };
}
const assess = (r: unknown, i: readonly NumstatEntry[], p: ReceiptProbe, baseline = "b1", opts = NO_RULING) =>
  assessCodeReceipts(r, { baseline, entries: i }, p, "/root", opts);
const rcpt = (receipt: string, base = "b1", head = "h1", cwd = "/clone", models: unknown = [astra], sessionId: unknown = "s1") =>
  ({ cwd, base, head, receipt, models, sessionId });
const ONE = { observed: [{ provider: "codex", model: "gpt-6-astra" }], calls: 1, sessions: ["s1"] };

describe("assessCodeReceipts: rules (b) and (c)", () => {
  it("accepts a single-file range whose receipt count matches, within tolerance, and returns the call's evidence", async () => {
    const p = probe({ "b1..h1": z(["src/a.ts", 100, 20]) });
    expect(await assess([rcpt("REVIEWED: src/a.ts (~115 changed lines)")], item(["src/a.ts", 100, 20]), p)).toEqual({ ok: true, value: ONE });
    expect(p.calls).toEqual([["/clone", "b1", "h1"]]);
  });
  it("refuses a count outside tolerance: the reviewer did not see the piece the caller sent", async () => {
    const p = probe({ "b1..h1": z(["src/a.ts", 100, 20]) });
    expect(await assess([rcpt("REVIEWED: src/a.ts (~60 changed lines)")], item(["src/a.ts", 100, 20]), p))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/says ~60 changed lines but b1\.\.h1 has 120/) });
  });
  it("refuses missing, malformed and unparseable receipts", async () => {
    const p = probe({ "b1..h1": z(["a.ts", 1, 1]) });
    const it1 = item(["a.ts", 1, 1]);
    expect((await assess(undefined, it1, p)).ok).toBe(false);
    expect((await assess([], it1, p)).ok).toBe(false);
    expect(await assess([{ cwd: "/clone", base: "b1", head: "h1", models: [astra], sessionId: "s1" }], it1, p)).toMatchObject({ reason: expect.stringMatching(/receipt is missing/) });
    expect(await assess([rcpt("Looks good to me")], it1, p)).toMatchObject({ reason: expect.stringMatching(/does not read/) });
    expect(await assess(["REVIEWED: a.ts (~2 changed lines)"], it1, p)).toMatchObject({ reason: "reviewReceipts[0] is not an object" });
  });
  it("each call carries its own models[] and session: one call's evidence cannot cover another receipt", async () => {
    const p = probe({ "b0..b1": z(["a.ts", 5, 0]), "b1..h1": z(["a.ts", 5, 0]) });
    const it1 = item(["a.ts", 10, 0]);
    const first = rcpt("REVIEWED: a.ts (~5 changed lines)", "b0", "b1");
    // Overridden after construction: an `undefined` argument would take the helper's valid default.
    const noModels = { ...rcpt("REVIEWED: a.ts (~5 changed lines)", "b1", "h1"), models: undefined };
    expect(noModels.models).toBeUndefined();
    expect(await assess([first, noModels], it1, p, "b0"))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/^reviewReceipts\[1\]\.models: no bridge model receipt/) });
    expect(await assess([first, rcpt("REVIEWED: a.ts (~5 changed lines)", "b1", "h1", "/clone", [{ ...astra, selection: "provider_default" }])], it1, p, "b0"))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/^reviewReceipts\[1\]\.models: selection provider_default/) });
    expect(await assess([first, rcpt("REVIEWED: a.ts (~5 changed lines)", "b1", "h1", "/clone", [astra], " ")], it1, p, "b0"))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/^reviewReceipts\[1\]\.sessionId is missing/) });
    expect(await assess([first, rcpt("REVIEWED: a.ts (~5 changed lines)", "b1", "h1", "/clone", [astra], "s2")], it1, p, "b0"))
      .toEqual({ ok: true, value: { observed: [{ provider: "codex", model: "gpt-6-astra" }], calls: 2, sessions: ["s1", "s2"] } });
  });
  it("the observed models are the union across calls, and one Gemini call under the ruling discloses the whole review", async () => {
    const p = probe({ "b0..b1": z(["a.ts", 5, 0]), "b1..h1": z(["a.ts", 5, 0]) });
    const r = await assess([
      rcpt("REVIEWED: a.ts (~5 changed lines)", "b0", "b1"),
      rcpt("REVIEWED: a.ts (~5 changed lines)", "b1", "h1", "/clone", [gemini], "s2"),
    ], item(["a.ts", 10, 0]), p, "b0", { geminiRulingAccepted: true });
    expect(r).toEqual({ ok: true, value: {
      observed: [{ provider: "codex", model: "gpt-6-astra" }, { provider: "gemini", model: "Gemini 3.1 Pro (High)" }],
      disclosure: "gemini-under-owner-ruling", calls: 2, sessions: ["s1", "s2"],
    } });
  });
  it("refuses a relative cwd, a hyphen ref, and a cwd that is not a work tree", async () => {
    const p = probe({ "b1..h1": z(["a.ts", 1, 1]) });
    const it1 = item(["a.ts", 1, 1]);
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)", "b1", "h1", "clone")], it1, p)).toMatchObject({ reason: expect.stringMatching(/absolute path/) });
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)", "--output=/tmp/x", "h1")], it1, p)).toMatchObject({ reason: expect.stringMatching(/plain git refs/) });
    expect(p.calls).toEqual([]);
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)")], it1, probe({}, { inWorkTree: async () => false }))).toMatchObject({ reason: expect.stringMatching(/not a git work tree/) });
  });
  it("accepts a ref with + and ~", async () => {
    const p = probe({ "feature/c++..h1~1": z(["a.ts", 1, 1]) }, {}, { "h1~1:a.ts": "h1:a.ts" });
    expect((await assess([rcpt("REVIEWED: a.ts (~2 changed lines)", "feature/c++", "h1~1")], item(["a.ts", 1, 1]), p, "feature/c++")).ok).toBe(true);
  });
  it("a probe failure is a named refusal, never a throw", async () => {
    const p = probe({});
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)")], item(["a.ts", 1, 1]), p))
      .toMatchObject({ ok: false, reason: "git diff failed in /clone: fatal: bad revision 'b1'" });
    const bad = probe({ "b1..h1": "junk" });
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)")], item(["a.ts", 1, 1]), bad)).toMatchObject({ reason: expect.stringMatching(/unparseable numstat/) });
  });
  it("refuses a range over 300 changed lines, counting only non-generated text files", async () => {
    const big = probe({ "b1..h1": z(["a.ts", 250, 51]) });
    expect(await assess([rcpt("REVIEWED: a.ts (~301 changed lines)")], item(["a.ts", 250, 51]), big)).toMatchObject({ reason: expect.stringMatching(/301 changed lines; split it to at most 300/) });
    const withLock = probe({ "b1..h1": z(["a.ts", 150, 50], ["package-lock.json", 900, 900], ["logo.png", null, null]) });
    expect((await assess([rcpt("REVIEWED: [range] (~200 changed lines)")], item(["a.ts", 150, 50], ["package-lock.json", 900, 900], ["logo.png", null, null]), withLock)).ok).toBe(true);
  });
  it("refuses a range that changes nothing", async () => {
    expect(await assess([rcpt("REVIEWED: [range] (~0 changed lines)")], item(["a.ts", 1, 1]), probe({ "b1..h1": "" }))).toMatchObject({ reason: "reviewReceipts[0] range b1..h1 changes nothing" });
  });
  it("a receipt naming a file the range does not change is refused", async () => {
    const p = probe({ "b1..h1": z(["a.ts", 1, 1]) });
    expect(await assess([rcpt("REVIEWED: b.ts (~2 changed lines)")], item(["a.ts", 1, 1]), p)).toMatchObject({ reason: expect.stringMatching(/names b\.ts, which b1\.\.h1 does not change/) });
  });
  it("[range] covers several files; a single-path receipt must be a range of that file alone", async () => {
    const p = probe({ "b1..h1": z(["a.ts", 10, 0], ["range", 5, 0]) });
    const both = item(["a.ts", 10, 0], ["range", 5, 0]);
    expect((await assess([rcpt("REVIEWED: [range] (~15 changed lines)")], both, p)).ok).toBe(true);
    expect(await assess([rcpt("REVIEWED: range (~5 changed lines)")], both, p))
      .toMatchObject({ reason: "reviewReceipts[0] receipt names only range but b1..h1 also changes a.ts: use [range] or a range of that file alone" });
  });
  it("coverage ties the receipts to the item's own baseline: an unrelated base of the same count is refused", async () => {
    const it1 = item(["a.ts", 20, 0]);
    // x0..h1 changes a.ts by exactly 20 lines and ends at the working tree, but starts from bytes the item never had.
    const same = probe({ "x0..h1": z(["a.ts", 20, 0]) });
    expect(await assess([rcpt("REVIEWED: a.ts (~20 changed lines)", "x0", "h1")], it1, same))
      .toEqual({ ok: false, reason: "unrelated base: reviewReceipts[0] reviews a.ts from x0, which does not hold it as the item baseline b1 does" });
    const unrelated = probe({ "b1..h1": z(["other.ts", 20, 0]) });
    expect(await assess([rcpt("REVIEWED: other.ts (~20 changed lines)")], it1, unrelated)).toMatchObject({ reason: "not reviewed: a.ts" });
  });
  it("duplicated, overlapping, missing and out-of-order chunks break the chain", async () => {
    const it1 = item(["a.ts", 200, 0]);
    const p = probe({ "b0..m1": z(["a.ts", 100, 0]), "m1..h1": z(["a.ts", 100, 0]), "b0..h1": z(["a.ts", 200, 0]), "b0..m2": z(["a.ts", 150, 0]) });
    const A = rcpt("REVIEWED: a.ts (~100 changed lines)", "b0", "m1");
    const B = rcpt("REVIEWED: a.ts (~100 changed lines)", "m1", "h1");
    expect((await assess([A, B], it1, p, "b0")).ok).toBe(true);
    expect(await assess([A, A, B], it1, p, "b0")).toMatchObject({ reason: expect.stringMatching(/^broken review chain for a\.ts: reviewReceipts\[1\] does not start where/) });
    expect(await assess([rcpt("REVIEWED: a.ts (~200 changed lines)", "b0", "h1"), rcpt("REVIEWED: a.ts (~200 changed lines)", "b0", "h1")], it1, p, "b0"))
      .toMatchObject({ reason: expect.stringMatching(/^broken review chain for a\.ts: reviewReceipts\[1\]/) });
    expect(await assess([rcpt("REVIEWED: a.ts (~150 changed lines)", "b0", "m2"), B], it1, p, "b0"))
      .toMatchObject({ reason: expect.stringMatching(/^broken review chain for a\.ts: reviewReceipts\[1\]/) });
    expect(await assess([B, A], it1, p, "b0")).toMatchObject({ reason: expect.stringMatching(/^unrelated base: reviewReceipts\[0\] reviews a\.ts from m1/) });
    expect(await assess([A], it1, p, "b0")).toMatchObject({ reason: "stale review: the last review of a.ts does not end where the working tree is" });
  });
  it("one range per file, chained in turn, together cover a two-file item", async () => {
    // ha changes only a.ts, so b.ts at ha is still the baseline's; h1 changes only b.ts on top.
    const p = probe({ "b1..ha": z(["a.ts", 10, 0]), "ha..h1": z(["b.ts", 10, 0]) }, {}, { "ha:b.ts": "b1:b.ts", "h1:a.ts": "ha:a.ts" });
    const r = await assess([rcpt("REVIEWED: a.ts (~10 changed lines)", "b1", "ha"), rcpt("REVIEWED: b.ts (~10 changed lines)", "ha", "h1", "/clone", [astra], "s2")],
      item(["a.ts", 10, 0], ["b.ts", 10, 0]), p);
    expect(r).toMatchObject({ ok: true, value: { calls: 2, sessions: ["s1", "s2"] } });
  });
  it("binary and generated files must be in a reviewed range but are exempt from line counts", async () => {
    const it1 = item(["a.ts", 10, 0], ["logo.png", null, null]);
    const p = probe({ "b1..h1": z(["a.ts", 10, 0]) });
    expect(await assess([rcpt("REVIEWED: a.ts (~10 changed lines)")], it1, p)).toMatchObject({ reason: "not reviewed: logo.png" });
    const named = probe({ "b1..h1": z(["a.ts", 10, 0], ["logo.png", null, null]) });
    expect(await assess([rcpt("REVIEWED: [range] (~10 changed lines)")], it1, named)).toEqual({ ok: true, value: ONE });
  });
  it("a range may not count as binary a path the item changes as text: a binary step would hide its lines", async () => {
    // baseline -> a NUL blob -> 400 lines of text: each step is -/- and the chain holds.
    const p = probe({ "b1..hx": z(["big.txt", null, null]), "hx..h1": z(["big.txt", null, null]) });
    const split = [rcpt("REVIEWED: big.txt (~0 changed lines)", "b1", "hx"), rcpt("REVIEWED: big.txt (~0 changed lines)", "hx", "h1")];
    expect(await assess(split, item(["big.txt", 400, 0]), p)).toEqual({
      ok: false,
      reason: "reviewReceipts[0] range b1..hx counts big.txt as binary, but the item's own diff of it is text: review it in ranges that hold it as text",
    });
    // A path the item does not change at all is no binary the item granted either.
    expect(await assess(split, item(["other.ts", 1, 0]), p)).toMatchObject({ ok: false, reason: expect.stringMatching(/^reviewReceipts\[0\] range b1\.\.hx counts big\.txt as binary/) });
    // Positive control: the same chain passes when the item's own endpoints are binary.
    expect((await assess(split, item(["big.txt", null, null]), p)).ok).toBe(true);
  });
  it("the reviewed bytes must be the item's: the last head holds each path as the working tree does", async () => {
    const it1 = item(["a.ts", 10, 0]);
    const stale = probe({ "b1..h1": z(["a.ts", 10, 0]) }, { workEntry: async () => "other" });
    expect(await assess([rcpt("REVIEWED: a.ts (~10 changed lines)")], it1, stale)).toEqual({ ok: false, reason: "stale review: the last review of a.ts does not end where the working tree is" });
    const deleted = probe({ "b1..h1": z(["gone.ts", 0, 4]) }, {}, { "h1:gone.ts": null });
    expect((await assess([rcpt("REVIEWED: gone.ts (~4 changed lines)")], item(["gone.ts", 0, 4]), deleted)).ok).toBe(true);
    const kept = probe({ "b1..h1": z(["gone.ts", 0, 4]) }, { workEntry: async () => null });
    expect(await assess([rcpt("REVIEWED: gone.ts (~4 changed lines)")], item(["gone.ts", 0, 4]), kept)).toMatchObject({ reason: expect.stringMatching(/^stale review: .*gone\.ts/) });
    const added = probe({ "b1..h1": z(["new.ts", 4, 0]) }, {}, { "b1:new.ts": null });
    expect((await assess([rcpt("REVIEWED: new.ts (~4 changed lines)")], item(["new.ts", 4, 0]), added)).ok).toBe(true);
  });
  it("a blob probe failure, even a non-stringifiable one, is a named refusal", async () => {
    const p = probe({ "b1..h1": z(["a.ts", 1, 1]) }, { workEntry: async () => { throw Object.create(null); } });
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)")], item(["a.ts", 1, 1]), p)).toEqual({ ok: false, reason: "could not compare a.ts with the reviewed commits: unknown error" });
    const q = probe({}, { numstat: async () => { throw Object.create(null); } });
    expect(await assess([rcpt("REVIEWED: a.ts (~2 changed lines)")], item(["a.ts", 1, 1]), q)).toEqual({ ok: false, reason: "git diff failed in /clone: unknown error" });
  });
});

describe("assessPlanReceipt", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
  const plan = { text, sha256: sha(text) };
  const pr = (receipt: string, planSha256: unknown = sha(text), models: unknown = [astra], sessionId: unknown = "s1") => ({ receipt, planSha256, models, sessionId });
  it("accepts a receipt whose digest is the plan's and whose line count matches within tolerance", () => {
    expect(assessPlanReceipt(pr("REVIEWED: plan.md (~40 lines)"), plan, NO_RULING)).toEqual({ ok: true, value: ONE });
    expect(assessPlanReceipt(pr("REVIEWED: plan.md (~36 lines)"), plan, NO_RULING).ok).toBe(true);
  });
  it("refuses a missing, malformed or mismatched receipt", () => {
    expect(assessPlanReceipt(undefined, plan, NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/no plan receipt/) });
    expect(assessPlanReceipt([pr("REVIEWED: plan.md (~40 lines)")], plan, NO_RULING)).toMatchObject({ ok: false, reason: expect.stringMatching(/no plan receipt/) });
    expect(assessPlanReceipt(pr("REVIEWED: other.md (~40 lines)"), plan, NO_RULING)).toMatchObject({ reason: expect.stringMatching(/does not read/) });
    expect(assessPlanReceipt(pr("REVIEWED: plan.md (~35 lines)"), plan, NO_RULING)).toMatchObject({ reason: "plan receipt says ~35 lines but plan.md has 40: the reviewer did not see this plan" });
  });
  it("a receipt reused for a different plan of equal length is refused on its digest", () => {
    const other = text.replace("line 7", "line Z");
    expect(other.split("\n").length).toBe(text.split("\n").length);
    expect(assessPlanReceipt(pr("REVIEWED: plan.md (~40 lines)"), { text: other, sha256: sha(other) }, NO_RULING))
      .toEqual({ ok: false, reason: "plan receipt digest does not match plan.md: the reviewer did not see this plan" });
  });
  it("refuses a missing or malformed digest, and a call without gate-grade evidence", () => {
    // Overridden after construction: an `undefined` argument would take the helper's valid default.
    const noDigest = { ...pr("REVIEWED: plan.md (~40 lines)"), planSha256: undefined };
    expect(noDigest.planSha256).toBeUndefined();
    expect(assessPlanReceipt(noDigest, plan, NO_RULING)).toMatchObject({ reason: expect.stringMatching(/planSha256 must be the lowercase sha256/) });
    expect(assessPlanReceipt(pr("REVIEWED: plan.md (~40 lines)", sha(text).toUpperCase()), plan, NO_RULING)).toMatchObject({ reason: expect.stringMatching(/planSha256 must be/) });
    const noPlanModels = { ...pr("REVIEWED: plan.md (~40 lines)"), models: undefined };
    expect(noPlanModels.models).toBeUndefined();
    expect(assessPlanReceipt(noPlanModels, plan, NO_RULING)).toMatchObject({ reason: expect.stringMatching(/^reviewReceipts\.models: no bridge model receipt/) });
    expect(assessPlanReceipt(pr("REVIEWED: plan.md (~40 lines)", sha(text), [astra], null), plan, NO_RULING)).toMatchObject({ reason: expect.stringMatching(/^reviewReceipts\.sessionId is missing/) });
  });
});
