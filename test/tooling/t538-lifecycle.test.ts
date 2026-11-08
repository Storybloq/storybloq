// T-538 S5b-0 commit 5: section 11's cleanup order, retry, quarantine, retention and stop cause, on fakes.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetFrom } from "../../scripts/onboarding-eval-limits.js";
import { classifyStop, closeQuarantine, quarantineCheck, retainTar, runCleanup, writeQuarantine, type CleanupOps, type StepResult, type StopCause } from "../../scripts/onboarding-eval-lifecycle.js";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const b = budgetFrom(T0);
const OK: StepResult = { ok: true };
const cause: StopCause = { reason: "flow-ended", decided: true, oomKilledNote: false, detail: "the flow ended" };

/** A fake: every op records its call and deadline; `spend` advances the clock by what each op takes. */
type Hung = "stop" | "confirm" | "proxy" | "pack1" | "pack2" | "retain" | "remove";
function fake(start: number, over: Partial<Record<"stop" | "proxyPack" | "retain", StepResult>> & { packs?: StepResult[]; running?: boolean; clear?: boolean; left?: number; spend?: Partial<Record<string, number>>; hang?: Hung[]; throws?: Hung[] } = {}) {
  let t = start;
  const calls: string[] = [];
  const deadlines: Record<string, number> = {};
  const quarantines: string[] = [];
  const spend = (k: string) => { t += over.spend?.[k] ?? 1000; };
  const packs = [...(over.packs ?? [OK])];
  // A hung operation never settles; one that throws rejects. Both must still reach a bounded outcome.
  const gate = async <T>(k: Hung, v: () => T): Promise<T> => {
    if (over.hang?.includes(k)) return new Promise<T>(() => {});
    if (over.throws?.includes(k)) throw new Error(`${k} broke`);
    return v();
  };
  const ops: CleanupOps = {
    now: () => t,
    // The fake timer fires after the event loop turns, so an operation that settles first always wins; it
    // then moves the clock to the deadline, as a real timer would.
    wait: async (ms, signal) => { await new Promise((r) => setImmediate(r)); if (!signal.aborted) t += ms; },
    writeStopRecord: () => { calls.push("stop-record"); },
    stop: (d) => { calls.push("stop"); deadlines.stop = d; return gate("stop", () => { spend("stop"); return over.stop ?? OK; }); },
    confirm: (d) => { calls.push("confirm"); deadlines.confirm = d; return gate("confirm", () => ({ running: over.running ?? false, status: over.running ? "running" : "exited", oomKilled: false })); },
    proxyPack: (d) => { calls.push("proxy-pack"); deadlines.proxy = d; return gate("proxy", () => { spend("proxy"); return over.proxyPack ?? OK; }); },
    attemptPack: (d, n) => { calls.push(`attempt-pack-${n}`); deadlines[`pack${n}`] = d; return gate(n === 1 ? "pack1" : "pack2", () => { spend(`pack${n}`); return packs.shift() ?? OK; }); },
    clearStaging: () => { calls.push("clear-staging"); t += over.spend?.clear ?? 0; return over.clear ?? true; },
    writeState: () => { calls.push("state"); },
    retain: (d) => { calls.push("retain"); deadlines.retain = d; return gate("retain", () => over.retain ?? OK); },
    removeObjects: (d) => { calls.push("remove"); deadlines.remove = d; return gate("remove", () => ({ left: over.left ?? 0 })); },
    writeQuarantine: (r) => { calls.push("quarantine"); quarantines.push(r); },
  };
  return { ops, calls, deadlines, quarantines, at: () => t };
}

describe("classifyStop: the runner's recorded decision is the cause of record", () => {
  it("a recorded decision wins over the clock and the exit", () => {
    const c = classifyStop({ decision: { reason: "limit", detail: "sharge under its threshold" }, exitedAt: T0 + MIN, deadline: b.attemptDeadline, oomKilled: true });
    expect(c).toEqual({ reason: "limit", decided: true, oomKilledNote: true, detail: "sharge under its threshold" });
  });
  it("an unrequested exit at or after the deadline is the deadline; before it is an unrequested exit", () => {
    expect(classifyStop({ decision: null, exitedAt: b.attemptDeadline, deadline: b.attemptDeadline, oomKilled: null }).reason).toBe("deadline");
    expect(classifyStop({ decision: null, exitedAt: b.attemptDeadline - 1, deadline: b.attemptDeadline, oomKilled: null }).reason).toBe("unrequested-exit");
  });
  it("OOMKilled is a note only, never the cause", () => {
    const c = classifyStop({ decision: null, exitedAt: T0 + MIN, deadline: b.attemptDeadline, oomKilled: true });
    expect(c.reason).toBe("unrequested-exit");
    expect(c.oomKilledNote).toBe(true);
    expect(c.detail).toContain("a tool can cause");
    expect(classifyStop({ decision: null, exitedAt: T0 + MIN, deadline: b.attemptDeadline, oomKilled: null }).oomKilledNote).toBe(false);
  });
});

describe("runCleanup: section 11's order", () => {
  it("the happy path runs steps 1 to 7 in order and packs", async () => {
    const f = fake(T0 + 100 * MIN);
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toEqual(["stop-record", "stop", "confirm", "proxy-pack", "attempt-pack-1", "state", "retain", "remove"]);
    expect(o).toMatchObject({ disposition: "packed", corroboration: "available", retention: "done", cleanup: "done", findings: [] });
  });
  it("each operation gets its own capped deadline from the clock at its start", async () => {
    const f = fake(T0 + 100 * MIN);
    await runCleanup(b, cause, f.ops);
    expect(f.deadlines.stop).toBe(T0 + 100 * MIN + 25_000);
    expect(f.deadlines.proxy).toBe(T0 + 100 * MIN + 1000 + 2 * MIN);
    expect(f.deadlines.pack1).toBe(T0 + 100 * MIN + 2000 + 20 * MIN);
  });
  it("a proxy pack failure keeps going: the attempt packs, corroboration is evidence-lost", async () => {
    const f = fake(T0 + 100 * MIN, { proxyPack: { ok: false, reason: "helper exited 70" } });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toContain("attempt-pack-1");
    expect(o.disposition).toBe("packed");
    expect(o.corroboration).toBe("evidence-lost");
    expect(o.findings).toEqual(["proxy pack: helper exited 70; its volume is kept"]);
  });
  it("a stop that leaves the attempt running quarantines at once, nothing packed and nothing removed", async () => {
    const f = fake(T0 + 100 * MIN, { stop: { ok: false, reason: "docker stop timed out" }, running: true });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toEqual(["stop-record", "stop", "confirm", "quarantine"]);
    expect(o.disposition).toBe("quarantined");
    expect(o.findings[0]).toContain("docker stop timed out");
    expect(f.quarantines).toEqual(["the attempt could not be stopped"]);
  });
  it("the stop record is written before the stop is attempted", async () => {
    const f = fake(T0 + 100 * MIN);
    await runCleanup(b, cause, f.ops);
    expect(f.calls.indexOf("stop-record")).toBeLessThan(f.calls.indexOf("stop"));
  });
});

describe("runCleanup: one retry, only after the staging is removed and with five minutes left", () => {
  it("a failed first pack clears its staging and retries once", async () => {
    const f = fake(T0 + 100 * MIN, { packs: [{ ok: false, reason: "exit 74" }, OK] });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toEqual(["stop-record", "stop", "confirm", "proxy-pack", "attempt-pack-1", "clear-staging", "attempt-pack-2", "state", "retain", "remove"]);
    expect(o.disposition).toBe("packed");
    expect(o.findings).toEqual(["attempt pack try 1: exit 74"]);
  });
  it("two failures quarantine; there is no third try and nothing is removed", async () => {
    const f = fake(T0 + 100 * MIN, { packs: [{ ok: false, reason: "exit 74" }, { ok: false, reason: "exit 75" }] });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls.filter((c) => c.startsWith("attempt-pack"))).toEqual(["attempt-pack-1", "attempt-pack-2"]);
    expect(f.calls).not.toContain("remove");
    expect(f.calls).not.toContain("state");
    expect(o.disposition).toBe("quarantined");
    expect(f.quarantines).toEqual(["attempt pack try 2: exit 75"]);
  });
  it("staging that cannot be removed means no retry", async () => {
    const f = fake(T0 + 100 * MIN, { packs: [{ ok: false, reason: "exit 74" }, OK], clear: false });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).not.toContain("attempt-pack-2");
    expect(o.disposition).toBe("quarantined");
    expect(f.quarantines[0]).toContain("staging could not be removed");
  });
  it("under five minutes left after the failed try means no retry", async () => {
    // Start 225 min in; each op takes 1 s but the first pack takes 6 min, leaving 237-2-231 = 4 min.
    const f = fake(T0 + 225 * MIN, { packs: [{ ok: false, reason: "exit 74" }, OK], spend: { pack1: 6 * MIN - 3000 } });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).not.toContain("attempt-pack-2");
    expect(f.quarantines).toEqual(["under five minutes left, so there is no retry"]);
    expect(o.disposition).toBe("quarantined");
  });
  it("exactly five minutes left still retries", async () => {
    const f = fake(T0 + 225 * MIN, { packs: [{ ok: false, reason: "exit 74" }, OK], spend: { pack1: 5 * MIN - 2000 } });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toContain("attempt-pack-2");
    expect(o.disposition).toBe("packed");
  });
  it("the five minutes are measured after the staging removal, not before it", async () => {
    // After the failed try exactly 5 min remain; the removal takes 1 s, which leaves too little.
    const f = fake(T0 + 225 * MIN, { packs: [{ ok: false, reason: "exit 74" }, OK], spend: { pack1: 5 * MIN - 2000, clear: 1000 } });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toContain("clear-staging");
    expect(f.calls).not.toContain("attempt-pack-2");
    expect(o.disposition).toBe("quarantined");
  });
  it("an operation with under a minute available is not started, so the stop cannot be confirmed: quarantine", async () => {
    const f = fake(T0 + 234 * MIN + 1);
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toEqual(["stop-record", "quarantine"]);
    expect(o.disposition).toBe("quarantined");
    expect(o.corroboration).toBe("evidence-lost");
    expect(o.findings).toEqual(["the stop could not be confirmed: the inspect under a minute left, not started"]);
    expect(f.quarantines).toEqual(["the stop could not be confirmed"]);
  });
  it("a pack with under a minute left is not started", async () => {
    // The proxy pack takes the time down to 59 s available before the attempt pack.
    const f = fake(T0 + 230 * MIN, { spend: { proxy: 4 * MIN + 1000 } });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).not.toContain("attempt-pack-1");
    expect(o.findings).toContain("attempt pack try 1: under a minute left, not started");
    expect(o.disposition).toBe("quarantined");
  });
});

describe("runCleanup: every awaited operation is bounded by its deadline", () => {
  const start = T0 + 100 * MIN;
  it("an inspect that never answers quarantines by the clock, at the budget's remaining time", async () => {
    const f = fake(start, { hang: ["confirm"] });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.deadlines.confirm).toBe(b.budgetEnd - 2 * MIN);
    expect(f.at()).toBe(b.budgetEnd - 2 * MIN);
    expect(o).toMatchObject({ disposition: "quarantined", corroboration: "evidence-lost" });
    expect(o.findings).toEqual(["the stop could not be confirmed: the inspect did not finish by its deadline"]);
    expect(f.calls).not.toContain("proxy-pack");
  });
  it("a retention that never answers is pending by the clock; the budget is then spent, so removal is not started", async () => {
    const f = fake(start, { hang: ["retain"] });
    const o = await runCleanup(b, cause, f.ops);
    expect(o).toMatchObject({ disposition: "packed", retention: "pending", cleanup: "objects-left" });
    expect(o.findings).toEqual(["retention-pending: did not finish by its deadline", "cleanup: the removal under a minute left, not started, so labelled objects may be left"]);
    expect(f.calls).not.toContain("remove");
    expect(f.at()).toBe(b.budgetEnd - 2 * MIN);
  });
  it("a removal that never answers is objects-left, and the outcome is still returned", async () => {
    const f = fake(start, { hang: ["remove"] });
    const o = await runCleanup(b, cause, f.ops);
    expect(o).toMatchObject({ disposition: "packed", retention: "done", cleanup: "objects-left" });
    expect(o.findings).toEqual(["cleanup: the removal did not finish by its deadline, so labelled objects may be left"]);
    expect(f.at()).toBe(b.budgetEnd - 2 * MIN);
  });
  it("a stop that never answers is bounded by its 25 s cap and the confirm decides", async () => {
    const f = fake(start, { hang: ["stop"], running: true });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.deadlines.stop).toBe(start + 25_000);
    expect(f.calls).toEqual(["stop-record", "stop", "confirm", "quarantine"]);
    expect(o.findings).toEqual(["the attempt is still running after the stop (did not finish by its deadline)"]);
  });
  it("a proxy pack that never answers is bounded by its 2 min cap; the attempt still packs", async () => {
    const f = fake(start, { hang: ["proxy"] });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.deadlines.pack1).toBe(start + 1000 + 2 * MIN + 20 * MIN);
    expect(o).toMatchObject({ disposition: "packed", corroboration: "evidence-lost" });
  });
  it("an attempt pack that never answers counts as a failed try, then the retry runs", async () => {
    const f = fake(start, { hang: ["pack1"] });
    const o = await runCleanup(b, cause, f.ops);
    expect(f.calls).toContain("attempt-pack-2");
    expect(o.findings).toEqual(["attempt pack try 1: did not finish by its deadline"]);
    expect(o.disposition).toBe("packed");
  });
  it("an operation that throws is a failure with its message, not an escaped rejection", async () => {
    const f = fake(start, { throws: ["retain", "remove"] });
    const o = await runCleanup(b, cause, f.ops);
    expect(o.findings).toEqual(["retention-pending: failed (retain broke)", "cleanup: the removal failed (remove broke), so labelled objects may be left"]);
  });
});

describe("runCleanup: retention and removal do not change the disposition", () => {
  it("a retention failure is retention-pending; the attempt is still packed", async () => {
    const f = fake(T0 + 100 * MIN, { retain: { ok: false, reason: "the copy's hash differs" } });
    const o = await runCleanup(b, cause, f.ops);
    expect(o).toMatchObject({ disposition: "packed", retention: "pending" });
    expect(o.findings).toEqual(["retention-pending: the copy's hash differs"]);
    expect(f.calls).toContain("remove");
  });
  it("objects left after removal are named and keep the disposition", async () => {
    const f = fake(T0 + 100 * MIN, { left: 2 });
    const o = await runCleanup(b, cause, f.ops);
    expect(o).toMatchObject({ disposition: "packed", cleanup: "objects-left" });
    expect(o.findings).toEqual(["cleanup: 2 labelled objects are left"]);
  });
});

const dirs: string[] = [];
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "t538-life-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("retainTar: copy, re-hash, then remove the source", () => {
  it("moves when the copy's hash matches, with folder 0700", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "tar bytes");
    const r = retainTar(src, join(d, "keep"), sha("tar bytes"));
    expect(r).toEqual({ status: "moved", path: join(d, "keep", "a.tar") });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(join(d, "keep", "a.tar"), "utf-8")).toBe("tar bytes");
    expect(statSync(join(d, "keep")).mode & 0o777).toBe(0o700);
  });
  it("a copy whose hash differs is retention-pending; the source stays and the copy is named", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "tar bytes");
    const r = retainTar(src, join(d, "keep"), sha("tar bytes"), (_f, to) => writeFileSync(to, "torn"));
    expect(r).toMatchObject({ status: "retention-pending", path: src });
    const left = r.status === "retention-pending" ? r.leftAt : undefined;
    expect(left).toMatch(/\/keep\/\.a\.tar\.part-[0-9a-f]{12}$/);
    expect(readFileSync(left!, "utf-8")).toBe("torn");
    expect(existsSync(join(d, "keep", "a.tar"))).toBe(false);
    expect(existsSync(src)).toBe(true);
  });
  it("an archive already retained under that name keeps its bytes; the source stays untouched", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "new bytes");
    const keep = join(d, "keep");
    mkdirSync(keep);
    writeFileSync(join(keep, "a.tar"), "earlier evidence");
    let copied = false;
    const r = retainTar(src, keep, sha("new bytes"), (f, to) => { copied = true; copyFileSync(f, to); });
    expect(r).toMatchObject({ status: "retention-pending", path: src, reason: "an archive of that name is already retained, so it is kept and this one stays" });
    expect(copied).toBe(false);
    expect(readFileSync(join(keep, "a.tar"), "utf-8")).toBe("earlier evidence");
    expect(readFileSync(src, "utf-8")).toBe("new bytes");
    expect(readdirSync(keep)).toEqual(["a.tar"]);
  });
  it("a name retained while the copy was checked is not overwritten: the publish fails and the source stays", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "new bytes");
    const keep = join(d, "keep");
    const r = retainTar(src, keep, sha("new bytes"), (f, to) => { copyFileSync(f, to); writeFileSync(join(keep, "a.tar"), "raced in"); });
    expect(r).toMatchObject({ status: "retention-pending", path: src, reason: "an archive of that name was retained meanwhile, so it is kept and this one stays" });
    expect(readFileSync(join(keep, "a.tar"), "utf-8")).toBe("raced in");
    expect(readFileSync(src, "utf-8")).toBe("new bytes");
    expect(readdirSync(keep)).toEqual(["a.tar"]);
  });
  it("the moved archive is 0600 and no part file is left", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "tar bytes");
    const r = retainTar(src, join(d, "keep"), sha("tar bytes"));
    expect(r.status).toBe("moved");
    expect(statSync(join(d, "keep", "a.tar")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(d, "keep"))).toEqual(["a.tar"]);
  });
  it("a failed copy is retention-pending with the error code; the source stays", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "tar bytes");
    const r = retainTar(src, join(d, "keep"), sha("tar bytes"), () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
    expect(r).toMatchObject({ status: "retention-pending", path: src, reason: "the copy failed (ENOSPC)" });
    expect(existsSync(src)).toBe(true);
  });
  it("an unavailable destination is retention-pending", () => {
    const d = scratch();
    const src = join(d, "a.tar");
    writeFileSync(src, "x");
    writeFileSync(join(d, "file"), "not a folder");
    const r = retainTar(src, join(d, "file", "keep"), sha("x"));
    expect(r.status).toBe("retention-pending");
    expect(existsSync(src)).toBe(true);
  });
});

describe("quarantine records", () => {
  it("are written once, 0600, and never overwritten", () => {
    const d = scratch();
    const p = writeQuarantine(d, { attemptId: "a1", volume: "v1", reason: "two pack failures", at: T0 });
    expect(p).toBe(join(d, "quarantine", "a1.json"));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ attemptId: "a1", volume: "v1", reason: "two pack failures", at: T0 });
    expect(() => writeQuarantine(d, { attemptId: "a1", volume: "v1", reason: "again", at: T0 })).toThrow(/EEXIST/);
  });
  it("any open one blocks the next attempt; one over 7 days old is reported", () => {
    const d = scratch();
    expect(quarantineCheck(d, T0)).toEqual({ refusal: null, stale: [] });
    writeQuarantine(d, { attemptId: "a1", volume: "v1", reason: "r", at: T0 });
    writeQuarantine(d, { attemptId: "a2", volume: "v2", reason: "r", at: T0 + 2 * 24 * 60 * MIN });
    const week = 7 * 24 * 60 * MIN;
    expect(quarantineCheck(d, T0 + week)).toEqual({ refusal: "a quarantine is open (a1, a2); the pen rules retry or remove before another attempt", stale: [] });
    expect(quarantineCheck(d, T0 + week + 1).stale).toEqual(["a1"]);
  });
  it("an unreadable record is reported stale and still blocks", () => {
    const d = scratch();
    writeQuarantine(d, { attemptId: "a1", volume: "v1", reason: "r", at: T0 });
    writeFileSync(join(d, "quarantine", "bad.json"), "{");
    const q = quarantineCheck(d, T0);
    expect(q.refusal).toContain("bad");
    expect(q.stale).toEqual(["bad"]);
  });
  it("an attempt id that is not one safe path component is refused before anything is written or renamed", () => {
    const d = scratch();
    const driver = join(d, "driver");
    mkdirSync(driver);
    writeFileSync(join(d, "escaped.json"), "outside");
    const bad = ["../escaped", "a/b", "a\\b", "", ".", "..", ".hidden", "x".repeat(129), "a\u0000b", "a b"];
    for (const id of bad) {
      expect(() => writeQuarantine(driver, { attemptId: id, volume: "v", reason: "r", at: T0 }), id).toThrow(/not a single safe path component/);
      expect(() => closeQuarantine(driver, id, "cpm-75"), id).toThrow(/not a single safe path component/);
    }
    expect(existsSync(join(driver, "quarantine"))).toBe(false);
    expect(readdirSync(d).sort()).toEqual(["driver", "escaped.json"]);
    expect(readFileSync(join(d, "escaped.json"), "utf-8")).toBe("outside");
    expect(() => writeQuarantine(driver, { attemptId: "x".repeat(128), volume: "v", reason: "r", at: T0 })).not.toThrow();
    expect(() => writeQuarantine(driver, { attemptId: "a1.retry-2_b", volume: "v", reason: "r", at: T0 })).not.toThrow();
  });
  it("a closed record no longer blocks", () => {
    const d = scratch();
    writeQuarantine(d, { attemptId: "a1", volume: "v1", reason: "r", at: T0 });
    closeQuarantine(d, "a1", "cpm-75");
    expect(quarantineCheck(d, T0).refusal).toBeNull();
    expect(existsSync(join(d, "quarantine", "a1.closed-cpm-75"))).toBe(true);
  });
});
