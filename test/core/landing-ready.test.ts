/**
 * C-v4.1 commit 6, plan sections 3.7 and 7: landing-ready over a pure
 * ancestry oracle, the B4 precedence table through both landingReady and
 * proof, and the policy resolver (pen ruling Q1).
 */
import { describe, expect, it } from "vitest";
import { computeLandingReadiness, DEFAULT_LANDING_POLICY, inReadinessScope, parseCandidate, resolveLandingPolicy, type AncestryOracle, type LandingPolicy } from "../../src/core/landing-ready.js";
import { currentAttempts, ReceiptSchema, type Receipt } from "../../src/core/receipts.js";

type Json = Record<string, unknown>;
const sha = (c: string): string => c.repeat(40);
const A = sha("a");
const B = sha("b");
const H = sha("c");
const H2 = sha("d");

/** A linear history A <- B <- H, with H2 on a side branch off B; all but H2 on the default branch. */
const order = [A, B, H];
const git: AncestryOracle = {
  isAncestor: (x, y) => {
    if (x === y) return true;
    if (y === H2) return x === A || x === B;
    const i = order.indexOf(x);
    const j = order.indexOf(y);
    return i >= 0 && j >= 0 && i <= j;
  },
  onDefault: (s) => order.includes(s),
};

let seq = 0;
function rc(kind: Receipt["kind"], over: Json = {}): Json {
  seq += 1;
  const s = (over.sha as string | undefined) ?? H;
  const base: Json = {
    id: `rc-${String(seq).padStart(16, "0")}`, v: 1, kind, target: "T-001", repo: "b-0000000000000000", sha: s,
    revisions: {}, observation: { head: s, headMatchesSha: true, worktree: { staged: 0, unstaged: 0, untracked: 0, submodule: 0 } },
    result: "pass", recordedAt: `2026-11-16T00:00:${String(seq % 60).padStart(2, "0")}Z`, recordedBy: "test",
  };
  if (kind === "test" || kind === "device") base.attestation = { builtFromSha: s, builtClean: true };
  if (kind === "review") { base.base = A; base.data = { verdict: "approve" }; }
  if (kind === "device") { base.unitRef = "b-0000000000000000:T-001"; base.data = { deviceClass: "real" }; }
  const out = { ...base, ...over };
  if (kind === "review" && out.result !== "pass" && (over.data === undefined)) out.data = { verdict: "request_changes" };
  ReceiptSchema.parse(out);
  return out;
}

const record = (...receipts: Json[]): Json => ({ id: "T-001", receipts });
const ready = (rec: Json, cand = `${A}..${H}`, policy: LandingPolicy = DEFAULT_LANDING_POLICY) =>
  computeLandingReadiness(rec, parseCandidate(cand)!, policy, git);

describe("landing-ready (C-v4.1 commit 6, section 7)", () => {
  it("parses a full sha or a full range and nothing else", () => {
    expect(parseCandidate(H)).toEqual({ head: H });
    expect(parseCandidate(`${A}..${H}`)).toEqual({ base: A, head: H });
    expect(parseCandidate("abc123")).toBeUndefined();
    expect(parseCandidate(`${A}...${H}`)).toBeUndefined();
  });

  it("is ready with a passing test and a review covering the range; mutant and device are optional by default", () => {
    const r = ready(record(rc("test"), rc("review")));
    expect(r).toMatchObject({ ready: true, missing: [], failing: [], concurrent: [], contradictions: [], candidate: { head: H, base: A } });
  });

  it("names what is missing", () => {
    expect(ready(record(rc("test")))).toMatchObject({ ready: false, missing: ["review"] });
    expect(ready(record())).toMatchObject({ ready: false, missing: ["test", "review"] });
  });

  it("a test on another head does not satisfy H (section 7)", () => {
    expect(ready(record(rc("test", { sha: H2 }), rc("review")))).toMatchObject({ ready: false, missing: ["test"] });
  });

  it("a review of B..H does not satisfy A..H when B is not an ancestor of A; a review of A..H satisfies B..H", () => {
    expect(ready(record(rc("test"), rc("review", { base: B })))).toMatchObject({ ready: false, missing: ["review"] });
    expect(ready(record(rc("test"), rc("review", { base: A })), `${B}..${H}`)).toMatchObject({ ready: true });
  });

  it("a review matched on head alone is not enough: the base must cover the range", () => {
    const r = rc("review", { base: H2, sha: H });
    expect(inReadinessScope(ReceiptSchema.parse(r), "review", { base: A, head: H }, git)).toBe(false);
  });

  it("a sha-only candidate needs the review base to be an ancestor reachable from the default branch", () => {
    expect(ready(record(rc("test"), rc("review", { base: B })), H)).toMatchObject({ ready: true });
    expect(ready(record(rc("test", { sha: H2 }), rc("review", { base: H2, sha: H2 })), H2)).toMatchObject({ ready: false, missing: ["review"] });
  });

  describe("3.7 through readiness", () => {
    it("a pass superseded by a fail gives failing", () => {
      const p = rc("test");
      expect(ready(record(p, rc("test", { result: "fail", supersedes: [p.id] }), rc("review")))).toMatchObject({ ready: false, failing: ["test"] });
    });

    it("a pass and a fail on two branches, merged in either order, give concurrent", () => {
      const p = rc("test");
      const f = rc("test", { result: "fail" });
      expect(ready(record(p, f, rc("review")))).toMatchObject({ ready: false, concurrent: ["test"] });
      expect(ready(record(f, p, rc("review")))).toMatchObject({ ready: false, concurrent: ["test"] });
    });

    it("a later pass superseding both gives pass", () => {
      const p = rc("test");
      const f = rc("test", { result: "fail" });
      expect(ready(record(p, f, rc("test", { supersedes: [p.id, f.id] }), rc("review")))).toMatchObject({ ready: true });
    });

    it("a simulator device receipt superseding a real pass removes the pass under a real policy", () => {
      const real = rc("device");
      const sim = rc("device", { data: { deviceClass: "simulator" }, supersedes: [real.id] });
      const policy: LandingPolicy = { ...DEFAULT_LANDING_POLICY, device: "real" };
      expect(ready(record(rc("test"), rc("review"), real), `${A}..${H}`, policy)).toMatchObject({ ready: true });
      expect(ready(record(rc("test"), rc("review"), real, sim), `${A}..${H}`, policy)).toMatchObject({ ready: false, missing: ["device (no real-device pass)"] });
    });

    it("a superseder outside the scope (another head) removes nothing", () => {
      const p = rc("test");
      expect(ready(record(p, rc("test", { sha: H2, result: "fail", supersedes: [p.id] }), rc("review")))).toMatchObject({ ready: true });
    });
  });

  it("device real is never satisfied by a simulator pass alone; device required takes any class", () => {
    const sim = rc("device", { data: { deviceClass: "simulator" } });
    expect(ready(record(rc("test"), rc("review"), sim), `${A}..${H}`, { ...DEFAULT_LANDING_POLICY, device: "real" })).toMatchObject({ ready: false, missing: ["device (no real-device pass)"] });
    expect(ready(record(rc("test"), rc("review"), sim), `${A}..${H}`, { ...DEFAULT_LANDING_POLICY, device: "required" })).toMatchObject({ ready: true });
  });

  it("an optional kind that fails still holds the candidate", () => {
    expect(ready(record(rc("test"), rc("review"), rc("mutant", { result: "fail" })))).toMatchObject({ ready: false, failing: ["mutant"] });
  });

  it("an open receipt conflict is a contradiction and holds the candidate", () => {
    const t = rc("test");
    const rec = { ...record(t, rc("review")), _conflicts: [{ fieldPath: "receipts", kind: "receipt", id: t.id, base: null, ours: "d1", theirs: "d2" }] };
    expect(ready(rec)).toMatchObject({ ready: false, contradictions: [t.id] });
  });
});

describe("B4 precedence, one table through landingReady and proof", () => {
  // Each row is a set of current-attempt inputs; both callers must read the same outcome from currentAttempts.
  const rows: Array<{ name: string; make: () => Json[]; outcome: "none" | "concurrent" | "failing" | "pass" }> = [
    { name: "no receipts", make: () => [], outcome: "none" },
    { name: "a pass beside a fail", make: () => [rc("device"), rc("device", { result: "fail" })], outcome: "concurrent" },
    { name: "a pass superseded by a fail", make: () => { const p = rc("device"); return [p, rc("device", { result: "fail", supersedes: [p.id] })]; }, outcome: "failing" },
    { name: "a single pass", make: () => [rc("device")], outcome: "pass" },
  ];
  for (const row of rows) {
    it(`${row.name}: ${row.outcome}`, () => {
      const receipts = row.make();
      const parsed = receipts.map((r) => ReceiptSchema.parse(r));
      const readiness = ready(record(rc("test"), rc("review"), ...receipts), `${A}..${H}`, { ...DEFAULT_LANDING_POLICY, device: "required" });
      expect(readiness.kinds.find((k) => k.kind === "device")!.outcome).toBe(row.outcome);
      // proof's scope over the same receipts: every receipt is for the unit at the current revision.
      expect(currentAttempts(parsed, () => true).outcome).toBe(row.outcome);
    });
  }
});

describe("receipts.landingPolicy (pen ruling Q1)", () => {
  it("defaults, accepts valid values, and falls back per kind with a note, never a throw", () => {
    expect(resolveLandingPolicy({})).toEqual({ policy: DEFAULT_LANDING_POLICY, notes: [] });
    expect(resolveLandingPolicy({ receipts: { landingPolicy: { mutant: "required", device: "real" } } }).policy).toEqual({ ...DEFAULT_LANDING_POLICY, mutant: "required", device: "real" });
    const bad = resolveLandingPolicy({ receipts: { landingPolicy: { test: "maybe", device: "real" } } });
    expect(bad.policy).toEqual({ ...DEFAULT_LANDING_POLICY, device: "real" });
    expect(bad.notes).toEqual(['receipts.landingPolicy.test ignored ("maybe" is not required or optional); default required used']);
    expect(resolveLandingPolicy({ receipts: { landingPolicy: "strict" } }).notes[0]).toContain("not an object");
  });
});
