/**
 * T-525 E5 commit C: the home journal. Fake homes only; nothing here touches the real home or starts a client.
 * C1 journals and the strict writer (K3), C2 unconfirmed cleanup (H4) and the recovery decision table (K2),
 * C3 validation before grading for every crash point (H5), C4 the E5 drift and credential rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_GROUP, HOME_AFTER, HOME_BEFORE, HOME_CLASSIFIER_VERSION, HOME_DIAGNOSTIC, HOME_VIOLATIONS, HomeJournalStop, inventory, inventoryViolations,
  journalAfter, journalBefore, journalGroup, recoverHomeJournal, recoveryCleanup, validateHomeJournal, type InventoryFs, type JournalIo, type RecoveryProbe,
} from "../../scripts/continuity-home.js";
import { writeDurable } from "../../scripts/headless-common.js";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
let root: string; let home: string; let raw: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a7c-"));
  home = join(root, "home"); raw = join(root, "raw");
  mkdirSync(join(home, ".claude", "projects", "-w"), { recursive: true }); mkdirSync(raw);
  writeFileSync(join(home, ".claude.json"), "{}");
  writeFileSync(join(home, ".claude", ".credentials.json"), "x");
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  for (const d of ["plugins", "agents", "hooks", "skills"]) { mkdirSync(join(home, ".claude", d)); writeFileSync(join(home, ".claude", d, "keep"), "k"); }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "none"; } catch (e) { if (e instanceof HomeJournalStop) return e.code; throw e; } };
const json = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(raw, name), "utf-8")) as Record<string, unknown>;
const bump = (rel: string, size?: string): void => {
  const p = join(home, rel);
  if (size !== undefined) writeFileSync(p, size);
  const t = new Date(Date.now() + 60_000); utimesSync(p, t, t);
};
/** C-F6: a whole-second timestamp both sides, so a resized file differs from its baseline only in size. */
const PINNED_S = 1_790_000_000;
const pin = (rel: string): void => { utimesSync(join(home, rel), PINNED_S, PINNED_S); };
const resize = (rel: string, text: string): void => { writeFileSync(join(home, rel), text); pin(rel); };
const gone: RecoveryProbe = { group: () => "gone", identity: () => ({ kind: "start", value: "Thu Nov 12 10:00:00 2026" }) };
const plantGroup = (v: unknown): void => { writeFileSync(join(raw, CLIENT_GROUP), typeof v === "string" ? v : JSON.stringify(v)); };
const GROUP = { schema: 1, pgid: 4242, start: "Thu Nov 12 10:00:00 2026" };

describe("C1 / K3 the journals and the strict writer", () => {
  it("before, group, after and violations are written with their shapes", async () => {
    await journalBefore(raw, home);
    await journalGroup(raw, 4242, GROUP.start);
    writeFileSync(join(home, ".claude", "projects", "-w", `${SID}.jsonl`), "t");
    expect(await journalAfter(raw, home, "confirmed", [SID])).toEqual([]);
    expect(json(HOME_BEFORE)).toMatchObject({ schema: 1, classifier: HOME_CLASSIFIER_VERSION });
    expect(json(CLIENT_GROUP)).toEqual(GROUP);
    expect(json(HOME_AFTER)).toMatchObject({ schema: 1, cleanup: "confirmed", sessionIds: [SID] });
    expect(json(HOME_VIOLATIONS)).toEqual({ schema: 1, violations: [] });
  });
  it.each(["file fsync", "rename", "directory fsync"])("a %s failure in the journal writer is thrown, for the baseline and the group record", async (what) => {
    const io: JournalIo = { write: async () => { throw Object.assign(new Error(what), { code: "EIO" }); } };
    await expect(journalBefore(raw, home, io)).rejects.toThrow(what);
    await expect(journalGroup(raw, 4242, GROUP.start, io)).rejects.toThrow(what);
  });
  it("the journal's default writer is the strict one (a missing directory is thrown, never ignored)", async () => {
    await expect(journalGroup(join(raw, "absent"), 4242, GROUP.start)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeDurable(join(raw, "absent", "x"), "")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("M-C5: a baseline lstat error refuses before anything is written", async () => {
    const fs: InventoryFs = { lstat: (p) => { if (p.endsWith("settings.json")) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return lstatSync(p) as Stats; }, readdir: (p) => readdirSync(p) };
    expect(await code(journalBefore(raw, home, { write: writeDurable, inventoryFs: fs }))).toBe("home.baseline");
    expect(() => lstatSync(join(raw, HOME_BEFORE))).toThrow();
  });
});

describe("C2 (H4) an unconfirmed cleanup stops whatever the inventory says", () => {
  it("M-C7: normal completion with a clean inventory and an unconfirmed cleanup stops", async () => {
    await journalBefore(raw, home);
    expect(await code(journalAfter(raw, home, "unconfirmed", [SID]))).toBe("home.cleanup.unconfirmed");
    expect(json(HOME_AFTER)).toMatchObject({ cleanup: "unconfirmed" });
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.cleanup.unconfirmed");
  });
  it.each([["alive", "present"], ["unknown", "EPERM"]])("M-C8: recovery with the group %s writes a diagnostic, takes no terminal inventory, and stops", async (_n, answer) => {
    await journalBefore(raw, home); plantGroup(GROUP);
    const probe: RecoveryProbe = { group: () => answer, identity: () => ({ kind: "start", value: GROUP.start }) };
    expect(await code(recoverHomeJournal(raw, home, [SID], probe))).toBe("home.cleanup.unconfirmed");
    expect(() => lstatSync(join(raw, HOME_AFTER))).toThrow();
    expect(json(HOME_DIAGNOSTIC)).toMatchObject({ schema: 1 });
  });
});

describe("K2 the recovery decision table: only a valid record with a definitive absence is gone", () => {
  const signals: string[] = [];
  const probe = (group: string, identity: ReturnType<RecoveryProbe["identity"]>): RecoveryProbe => ({ group: (g) => { signals.push(`probe ${g}`); return group; }, identity: () => identity });
  const start = { kind: "start" as const, value: GROUP.start };
  it.each([
    ["the record missing", null, probe("gone", start), /no group record/],
    ["the record corrupt", "{not json", probe("gone", start), /corrupt/],
    ["an invalid pgid", { ...GROUP, pgid: 1 }, probe("gone", start), /no valid group/],
    ["the start identity absent", { ...GROUP, start: null }, probe("gone", start), /no recorded start identity/],
    ["a failed identity lookup", GROUP, probe("present", { kind: "failed", reason: "ps exited 2" }), /present; the leader's identity lookup failed/],
    ["the leader absent with the group surviving", GROUP, probe("present", { kind: "absent" }), /present; the leader is absent/],
    ["the leader changed with the group present", GROUP, probe("present", { kind: "start", value: "other" }), /present; the leader's identity changed/],
    ["EPERM", GROUP, probe("EPERM", start), /inaccessible \(EPERM\)/],
  ])("%s is unconfirmed, and nothing is signalled", (_n, rec, pr, reason) => {
    if (rec !== null) plantGroup(rec);
    const r = recoveryCleanup(raw, pr);
    expect(r.status).toBe("unconfirmed");
    expect((r as { reason: string }).reason).toMatch(reason);
    expect(signals.every((s) => s.startsWith("probe "))).toBe(true);
  });
  it("a valid record with ESRCH is gone, whatever the leader's identity", () => {
    plantGroup(GROUP);
    expect(recoveryCleanup(raw, probe("gone", { kind: "failed", reason: "x" }))).toEqual({ status: "gone" });
  });
  it("a before-only journal with no group record refuses; it does not assume no spawn happened", async () => {
    await journalBefore(raw, home);
    expect(await code(recoverHomeJournal(raw, home, [SID], gone))).toBe("home.cleanup.unconfirmed");
  });
});

describe("C3 (H5) every crash point, validated before grading", () => {
  const complete = async (): Promise<void> => { await journalBefore(raw, home); plantGroup(GROUP); await journalAfter(raw, home, "confirmed", [SID]); };
  it("none: no baseline refuses as unjournalled", async () => {
    expect(await code(recoverHomeJournal(raw, home, [SID], gone))).toBe("home.unjournalled");
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.unjournalled");
  });
  it("before only, the group gone: the terminal inventory is taken and validated", async () => {
    await journalBefore(raw, home); plantGroup(GROUP);
    expect(await recoverHomeJournal(raw, home, [SID], gone)).toEqual([]);
    expect(json(HOME_AFTER)).toMatchObject({ cleanup: "confirmed", sessionIds: [SID] });
  });
  it.each([["unparsable", "{\"schema\":1,"], ["the wrong schema", JSON.stringify({ schema: 2, cleanup: "confirmed", sessionIds: [SID], inventory: { entries: [], problems: [] } })]])("M-C4: a partial or corrupt terminal inventory (%s) refuses", async (_n, t) => {
    await journalBefore(raw, home); writeFileSync(join(raw, HOME_AFTER), t);
    expect(await code(recoverHomeJournal(raw, home, [SID], gone))).toBe("home.terminal");
  });
  it("M-C4: a missing terminal inventory is never validated as clean (before only, read at grading)", async () => {
    await journalBefore(raw, home); plantGroup(GROUP);
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.terminal");
    expect(() => lstatSync(join(raw, HOME_VIOLATIONS))).toThrow();
  });
  it("after without violations: completed from the recomputation and graded", async () => {
    await complete(); rmSync(join(raw, HOME_VIOLATIONS));
    expect(await validateHomeJournal(raw, { sessionIds: [SID] })).toEqual([]);
    expect(json(HOME_VIOLATIONS)).toEqual({ schema: 1, violations: [] });
  });
  it("M-C11: corrupt violations refuse, never completed", async () => {
    await complete(); writeFileSync(join(raw, HOME_VIOLATIONS), "{oops");
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.violations");
    expect(readFileSync(join(raw, HOME_VIOLATIONS), "utf-8")).toBe("{oops");
  });
  it("M-C9: stored violations that disagree with the recomputation refuse (a cleared list over a real change)", async () => {
    await journalBefore(raw, home); plantGroup(GROUP); bump(".claude/settings.json", "{\"a\":1}");
    expect(await code(journalAfter(raw, home, "confirmed", [SID]))).toBe("none");
    writeFileSync(join(raw, HOME_VIOLATIONS), JSON.stringify({ schema: 1, violations: [] }));
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.violations");
  });
  it("M-C10: mismatched session ids refuse", async () => {
    await complete();
    expect(await code(validateHomeJournal(raw, { sessionIds: [OTHER] }))).toBe("home.session-binding");
  });
  it("a wrong classifier version refuses", async () => {
    await complete();
    writeFileSync(join(raw, HOME_BEFORE), JSON.stringify({ ...json(HOME_BEFORE), classifier: HOME_CLASSIFIER_VERSION + 1 }));
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.baseline");
  });
  it("a link in a journal's place is refused, never followed", async () => {
    await complete(); const real = join(root, "elsewhere.json"); writeFileSync(real, readFileSync(join(raw, HOME_AFTER)));
    rmSync(join(raw, HOME_AFTER)); symlinkSync(real, join(raw, HOME_AFTER));
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.terminal");
  });
});

describe("C4 E5 drift and credential rows (inventoryViolations on fake homes)", () => {
  const drift = (change: () => void, ids: readonly string[] = [SID]): string[] => {
    const before = inventory(home); change(); return inventoryViolations(before, inventory(home), ids).map((c) => `${c.kind} ${c.rel}`);
  };
  it("M-C1: .credentials.json size only stops", () => {
    pin(".claude/.credentials.json"); const before = lstatSync(join(home, ".claude", ".credentials.json"));
    expect(drift(() => resize(".claude/.credentials.json", "xy"))).toContain("changed .claude/.credentials.json");
    const after = lstatSync(join(home, ".claude", ".credentials.json"));
    expect([after.mtimeMs, after.mode, after.size]).toEqual([before.mtimeMs, before.mode, before.size + 1]);
  });
  it("M-C1: .credentials.json mtime only stops", () => { expect(drift(() => bump(".claude/.credentials.json"))).toContain("changed .claude/.credentials.json"); });
  it(".claude.json size and mtime are allowed (the explicit exception)", () => { expect(drift(() => bump(".claude.json", "{\"n\":1}"))).toEqual([]); });
  it(".claude.json mode stops", () => { expect(drift(() => chmodSync(join(home, ".claude.json"), 0o600))).toContain("changed .claude.json"); });
  it("settings.json changed stops", () => { expect(drift(() => bump(".claude/settings.json", "{\"x\":2}"))).toContain("changed .claude/settings.json"); });
  it("M-C2: an unknown file added stops", () => { expect(drift(() => writeFileSync(join(home, ".claude", "mystery.bin"), "?"))).toContain("added .claude/mystery.bin"); });
  it.each([["a plugins/ entry added", () => writeFileSync(join(home, ".claude", "plugins", "new.json"), "{}"), "added .claude/plugins/new.json"],
    ["an agents/ file changed", () => bump(".claude/agents/keep", "kk"), "changed .claude/agents/keep"],
    ["a hooks/ file changed", () => bump(".claude/hooks/keep", "kk"), "changed .claude/hooks/keep"],
    ["a skills/ folder added", () => mkdirSync(join(home, ".claude", "skills", "x")), "added .claude/skills/x"]] as const)("E3 drift: %s stops", (_n, f, want) => {
    expect(drift(f)).toContain(want);
  });
  it("M-C3: an unrelated session's transcript stops; this run's is allowed", () => {
    expect(drift(() => writeFileSync(join(home, ".claude", "projects", "-w", `${OTHER}.jsonl`), "t"))).toContain(`added .claude/projects/-w/${OTHER}.jsonl`);
    expect(drift(() => writeFileSync(join(home, ".claude", "projects", "-w", `${SID}.jsonl`), "t"))).toEqual([]);
  });
});

describe("C-F1 a stored inventory is trusted only in the shape the inventory writes", () => {
  const complete = async (): Promise<void> => { await journalBefore(raw, home); plantGroup(GROUP); await journalAfter(raw, home, "confirmed", [SID]); };
  const tamper = (name: string, f: (inv: { entries: Record<string, unknown>[]; problems: Record<string, unknown>[] }) => void): void => {
    const j = json(name) as { inventory: { entries: Record<string, unknown>[]; problems: Record<string, unknown>[] } };
    f(j.inventory); writeFileSync(join(raw, name), JSON.stringify(j));
  };
  const want = (name: string): string => (name === HOME_BEFORE ? "home.baseline" : "home.terminal");
  it.each([HOME_BEFORE, HOME_AFTER])("duplicate paths in %s refuse", async (name) => {
    await complete(); rmSync(join(raw, HOME_VIOLATIONS));
    tamper(name, (inv) => { inv.entries.push({ ...inv.entries[1]!, size: 999 }); });
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe(want(name));
    expect(() => lstatSync(join(raw, HOME_VIOLATIONS))).toThrow();
  });
  it.each([HOME_BEFORE, HOME_AFTER])("a credential-bearing session path stored as runtime in %s refuses", async (name) => {
    const dir = join(home, ".claude", "projects", "-w", SID); mkdirSync(dir); writeFileSync(join(dir, "credentials.json"), "c");
    await complete(); rmSync(join(raw, HOME_VIOLATIONS));
    tamper(name, (inv) => { const e = inv.entries.find((x) => x.rel === `.claude/projects/-w/${SID}/credentials.json`)!; expect(e.class).toBe("credential"); e.class = "runtime"; });
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe(want(name));
  });
  it.each([
    ["a traversal path", (inv: { entries: Record<string, unknown>[] }) => { inv.entries[1]!.rel = ".claude/../.claude/settings.json"; }],
    ["a path outside the inventory roots", (inv: { entries: Record<string, unknown>[] }) => { inv.entries[1]!.rel = "Documents/x"; }],
    ["an unsupported type", (inv: { entries: Record<string, unknown>[] }) => { inv.entries[1]!.type = "fifo"; }],
    ["a non-finite size", (inv: { entries: Record<string, unknown>[] }) => { inv.entries[1]!.size = null; }],
    ["a negative size", (inv: { entries: Record<string, unknown>[] }) => { inv.entries[1]!.size = -1; }],
    ["an unsupported problem op", (inv: { entries: Record<string, unknown>[]; problems: Record<string, unknown>[] }) => { inv.problems.push({ rel: ".claude", op: "open", code: "EIO" }); }],
  ] as const)("%s in the terminal inventory refuses", async (_n, f) => {
    await complete(); rmSync(join(raw, HOME_VIOLATIONS));
    tamper(HOME_AFTER, f as never);
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }))).toBe("home.terminal");
  });
});

describe("C-F2 only ENOENT is absence: an unreadable journal is refused, never rebuilt", () => {
  const complete = async (): Promise<void> => { await journalBefore(raw, home); plantGroup(GROUP); await journalAfter(raw, home, "confirmed", [SID]); };
  const failing = (name: string, errno: string): JournalIo => ({ write: writeDurable, lstat: (p) => { if (p.endsWith(`/${name}`)) throw Object.assign(new Error(errno), { code: errno }); return lstatSync(p) as Stats; } });
  const snapshot = (): Record<string, string> => Object.fromEntries(readdirSync(raw).sort().map((n) => [n, readFileSync(join(raw, n), "utf-8")]));
  it.each(["EACCES", "EIO"])("%s on the baseline refuses as home.baseline, in validation and in recovery", async (errno) => {
    await complete(); const was = snapshot();
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }, failing(HOME_BEFORE, errno)))).toBe("home.baseline");
    expect(await code(recoverHomeJournal(raw, home, [SID], gone, failing(HOME_BEFORE, errno)))).toBe("home.baseline");
    expect(snapshot()).toEqual(was);
  });
  it.each(["EACCES", "EIO"])("%s on the terminal inventory refuses as home.terminal; recovery never takes a new one over it", async (errno) => {
    await complete(); const was = snapshot();
    expect(await code(recoverHomeJournal(raw, home, [SID], gone, failing(HOME_AFTER, errno)))).toBe("home.terminal");
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }, failing(HOME_AFTER, errno)))).toBe("home.terminal");
    expect(snapshot()).toEqual(was);
  });
  it.each(["EACCES", "EIO"])("%s on the violations refuses as home.violations; the file is never recreated", async (errno) => {
    await complete(); const was = snapshot();
    expect(await code(validateHomeJournal(raw, { sessionIds: [SID] }, failing(HOME_VIOLATIONS, errno)))).toBe("home.violations");
    expect(snapshot()).toEqual(was);
  });
  it.each(["EACCES", "EIO"])("%s on the group record is unconfirmed: a diagnostic, no terminal inventory", async (errno) => {
    await journalBefore(raw, home); plantGroup(GROUP);
    expect(recoveryCleanup(raw, gone, failing(CLIENT_GROUP, errno))).toMatchObject({ status: "unconfirmed", reason: expect.stringContaining(errno) });
    expect(await code(recoverHomeJournal(raw, home, [SID], gone, failing(CLIENT_GROUP, errno)))).toBe("home.cleanup.unconfirmed");
    expect(() => lstatSync(join(raw, HOME_AFTER))).toThrow();
    expect(json(HOME_DIAGNOSTIC)).toMatchObject({ schema: 1, reason: expect.stringContaining(errno) });
  });
});
