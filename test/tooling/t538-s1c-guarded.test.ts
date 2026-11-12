/**
 * T-538 signed-in note section 12, S1c: the schema-1 guarded lifecycle (intent, journal baseline, spawn with its group
 * and readback hooks, terminal journal, outcome, resolution) is guardedSpawn, extracted unchanged from continuity's
 * runAttempt. These rows inject a fault at each record and pin what is on disk afterwards. Continuity's own rows
 * (continuity-run.test.ts B-F2, B-F7, B-F8, W3 and C-F3) still drive the same code through runAttempt.
 * Model-free: the spawn is a fake, the home a fixture.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  guardedSpawn, PROVENANCE_INTENT_FILE, PROVENANCE_OUTCOME_FILE, PROVENANCE_READBACK_FILE, PROVENANCE_RECORD_SCHEMA, PROVENANCE_STOP_FILE,
  ProvenanceStopError, type GuardedRun, type GuardedSpawnCtx, type GuardedSpawnHooks,
} from "../../scripts/signed-in-attempt.js";
import * as viaContinuity from "../../scripts/continuity-run.js";
import { sha256 } from "../../scripts/continuity-lib.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538s1c-"))); dirs.push(d); return d; };

const SID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER = "1f1e1d1c-1b1a-4918-8716-151413121110";
const transcript = (sid = SID): string => `${JSON.stringify({ type: "system", subtype: "init", session_id: sid })}\n${JSON.stringify({ type: "result", subtype: "success" })}\n`;
const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf-8"));

interface Rig {
  readonly ctx: GuardedSpawnCtx;
  readonly rawDir: string;
  readonly home: string;
  /** Every durable write and fsync, in order: `write <file>` or `fsync <dir name>`. */
  readonly log: string[];
}
/** A real writer that records each write first and fails at the named file (the nth write of it). */
function rig(o: { guarded?: boolean; journal?: boolean; rawOutReal?: boolean; failAt?: string; failNth?: number; failFsync?: boolean; home?: string } = {}): Rig {
  const rawOut = tmp();
  const rawDir = join(rawOut, "abcdef012345", "c1", "a-001");
  mkdirSync(rawDir, { recursive: true });
  const home = o.home ?? tmp();
  if (o.home === undefined) { mkdirSync(join(home, ".claude")); writeFileSync(join(home, ".claude", "settings.json"), "{}"); }
  const log: string[] = [];
  const seen = new Map<string, number>();
  const ctx: GuardedSpawnCtx = {
    rawOut, rawDir, rawOutReal: o.rawOutReal ?? true, guarded: o.guarded ?? true,
    intentFields: { schema: PROVENANCE_RECORD_SCHEMA, sessionId: SID, expectedSha256: "e".repeat(64) },
    journalHome: (o.journal ?? true) ? home : undefined,
    transcriptPath: join(rawDir, "transcript.jsonl"),
    label: "c1#1",
    durable: async (p, text) => {
      const n = basename(p); const k = (seen.get(n) ?? 0) + 1; seen.set(n, k);
      log.push(`write ${n}`);
      if (n === o.failAt && k === (o.failNth ?? 1)) throw new Error(`injected: ${n}`);
      writeFileSync(p, text);
    },
    fsyncDir: async (d) => { log.push(`fsync ${basename(d)}`); if (o.failFsync === true) throw new Error("injected: fsync"); },
    chainParents: () => [join(rawOut, "abcdef012345"), join(rawOut, "abcdef012345", "c1")],
    startOf: (pid) => `start-${pid}`,
    readbackRecord: (r) => JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, expected: r.expected, steps: r.steps }),
  };
  return { ctx, rawDir, home, log };
}

interface FakeSpawn { readonly calls: GuardedSpawnHooks[]; readonly fn: (hooks: GuardedSpawnHooks) => Promise<GuardedRun & { readonly tag: string }> }
/** A child stand-in in driveClaude's shape: it records the group, writes the transcript, records the readback, and latches a hook failure. */
function fakeSpawn(o: { stop?: string; cleanup?: "confirmed" | "unconfirmed" | null; sid?: string; touchHome?: string; throws?: boolean } = {}, r?: Rig): FakeSpawn {
  const calls: GuardedSpawnHooks[] = [];
  return {
    calls,
    fn: async (hooks) => {
      calls.push(hooks);
      if (o.throws === true) throw new Error("injected: spawn");
      let stop: string | null = o.stop ?? null;
      if (hooks.onGroup !== undefined) { try { await hooks.onGroup(4242); } catch (e) { stop ??= `home.group-record: ${(e as Error).message}`; } }
      if (r !== undefined) writeFileSync(r.ctx.transcriptPath, transcript(o.sid));
      if (r !== undefined && o.touchHome !== undefined) writeFileSync(join(r.home, ".claude", o.touchHome), "x");
      if (hooks.onReadback !== undefined) { try { await hooks.onReadback({ expected: { nonce: "abcdef012345" } as never, steps: [] }); } catch (e) { stop ??= `readback.record: ${(e as Error).message}`; } }
      return { provenanceStop: stop, cleanup: o.cleanup === undefined ? "confirmed" : o.cleanup, readbackNonce: "abcdef012345", tag: "the run" };
    },
  };
}

describe("S1c: guardedSpawn is the extracted lifecycle", () => {
  it("is exported from signed-in-attempt and re-exported by continuity-run", () => {
    expect(viaContinuity.guardedSpawn).toBe(guardedSpawn);
  });

  it("runAttempt keeps no copy of the lifecycle: it calls guardedSpawn once and journals nothing itself", () => {
    const src = readFileSync(join(__dirname, "../../scripts/continuity-run.ts"), "utf-8");
    const body = src.slice(src.indexOf("export async function runAttempt("), src.indexOf("\nexport ", src.indexOf("export async function runAttempt(") + 10));
    expect(body.match(/guardedSpawn\(/g)).toHaveLength(1);
    for (const gone of ["journalBefore(", "journalGroup(", "journalAfter(", "PROVENANCE_OUTCOME_FILE", "PROVENANCE_READBACK_FILE", "a guarded run needs --raw-out"]) expect(body).not.toContain(gone);
  });
});

describe("S1c: the clean guarded, journalled attempt", () => {
  it("fsyncs the chain, writes the intent, baselines, spawns with both hooks, journals, then the outcome and the resolution, in that order", async () => {
    const r = rig();
    const s = fakeSpawn({}, r);
    const run = await guardedSpawn(r.ctx, s.fn);
    expect(run.tag).toBe("the run");
    expect(r.log).toEqual([
      "fsync abcdef012345", "fsync c1", `write ${PROVENANCE_INTENT_FILE}`, "write home.before.json", "write client.group.json",
      `write ${PROVENANCE_READBACK_FILE}`, "write home.after.json", "write home.violations.json", `write ${PROVENANCE_OUTCOME_FILE}`, `write ${PROVENANCE_INTENT_FILE}`,
    ]);
    expect(Object.keys(s.calls[0]!).sort()).toEqual(["onGroup", "onReadback"]);
    expect(read(join(r.rawDir, PROVENANCE_INTENT_FILE))).toEqual({ state: "resolved", ...r.ctx.intentFields });
    expect(read(join(r.rawDir, "client.group.json"))).toMatchObject({ pgid: 4242, start: "start-4242" });
    expect(readFileSync(join(r.rawDir, PROVENANCE_READBACK_FILE), "utf-8")).toBe(`${JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, expected: { nonce: "abcdef012345" }, steps: [] })}\n`);
    expect(read(join(r.rawDir, PROVENANCE_OUTCOME_FILE))).toEqual({ schema: PROVENANCE_RECORD_SCHEMA, sessionId: SID, nonce: "abcdef012345", cleanup: "confirmed", transcriptSha256: sha256(readFileSync(r.ctx.transcriptPath)) });
    expect(existsSync(join(r.rawDir, PROVENANCE_STOP_FILE))).toBe(false);
  });

  it("an unguarded, unjournalled spawn gets no hooks and nothing is fsynced or written", async () => {
    const r = rig({ guarded: false, journal: false });
    const s = fakeSpawn({ cleanup: null }, r);
    await expect(guardedSpawn(r.ctx, s.fn)).resolves.toMatchObject({ tag: "the run" });
    expect(s.calls[0]).toEqual({});
    expect(r.log).toEqual([]);
  });

  it("a guarded spawn with no journal home gets the readback hook only, and still resolves", async () => {
    const r = rig({ journal: false });
    const s = fakeSpawn({}, r);
    await guardedSpawn(r.ctx, s.fn);
    expect(Object.keys(s.calls[0]!)).toEqual(["onReadback"]);
    expect(r.log).toEqual(["fsync abcdef012345", "fsync c1", `write ${PROVENANCE_INTENT_FILE}`, `write ${PROVENANCE_READBACK_FILE}`, `write ${PROVENANCE_OUTCOME_FILE}`, `write ${PROVENANCE_INTENT_FILE}`]);
  });

  it("a journalled, unguarded spawn gets the group hook only and writes no intent, readback, outcome or resolution", async () => {
    const r = rig({ guarded: false });
    const s = fakeSpawn({}, r);
    await guardedSpawn(r.ctx, s.fn);
    expect(Object.keys(s.calls[0]!)).toEqual(["onGroup"]);
    expect(r.log).toEqual(["write home.before.json", "write client.group.json", "write home.after.json", "write home.violations.json"]);
  });
});

describe("S1c: a fault before the spawn starts nothing", () => {
  it("a guarded run whose --raw-out was not a real directory is refused before any fsync, write or spawn", async () => {
    const r = rig({ rawOutReal: false });
    const s = fakeSpawn({}, r);
    await expect(guardedSpawn(r.ctx, s.fn)).rejects.toThrow(`a guarded run needs --raw-out to exist as a real directory (not a link) before the run; ${r.ctx.rawOut} was not one`);
    expect(r.log).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it("a failed chain fsync writes no intent and starts nothing", async () => {
    const r = rig({ failFsync: true });
    const s = fakeSpawn({}, r);
    await expect(guardedSpawn(r.ctx, s.fn)).rejects.toThrow("injected: fsync");
    expect(r.log).toEqual(["fsync abcdef012345"]);
    expect(s.calls).toEqual([]);
  });

  it("a failed intent write starts nothing and writes nothing after it", async () => {
    const r = rig({ failAt: PROVENANCE_INTENT_FILE });
    const s = fakeSpawn({}, r);
    await expect(guardedSpawn(r.ctx, s.fn)).rejects.toThrow(`injected: ${PROVENANCE_INTENT_FILE}`);
    expect(r.log.at(-1)).toBe(`write ${PROVENANCE_INTENT_FILE}`);
    expect(s.calls).toEqual([]);
    expect(existsSync(join(r.rawDir, PROVENANCE_INTENT_FILE))).toBe(false);
  });

  it("a baseline the home cannot give is a durable home stop, with the intent left unresolved and nothing started", async () => {
    const file = join(tmp(), "home-is-a-file");
    writeFileSync(file, "");
    const r = rig({ home: file });
    const s = fakeSpawn({}, r);
    const e = await guardedSpawn(r.ctx, s.fn).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProvenanceStopError);
    expect((e as Error).message).toMatch(/^continuity-run: c1#1 stopped on the home journal: home\.baseline\. The turn is discarded/);
    expect(read(join(r.rawDir, PROVENANCE_STOP_FILE))).toEqual({ code: "home.baseline", cleanup: null, retryable: false });
    expect(read(join(r.rawDir, PROVENANCE_INTENT_FILE))).toMatchObject({ state: "unresolved" });
    expect(s.calls).toEqual([]);
  });

  it("a failed baseline write is thrown as it is, with no stop recorded and nothing started", async () => {
    const r = rig({ failAt: "home.before.json" });
    const s = fakeSpawn({}, r);
    const e = await guardedSpawn(r.ctx, s.fn).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(ProvenanceStopError);
    expect((e as Error).message).toBe("injected: home.before.json");
    expect(existsSync(join(r.rawDir, PROVENANCE_STOP_FILE))).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

describe("S1c: a fault during or after the spawn is never graded", () => {
  const noResolution = (r: Rig): void => {
    expect(read(join(r.rawDir, PROVENANCE_INTENT_FILE))).toMatchObject({ state: "unresolved" });
    expect(existsSync(join(r.rawDir, PROVENANCE_OUTCOME_FILE))).toBe(false);
  };

  it("a spawn that throws leaves the intent unresolved and writes no stop, outcome or terminal journal", async () => {
    const r = rig();
    await expect(guardedSpawn(r.ctx, fakeSpawn({ throws: true }, r).fn)).rejects.toThrow("injected: spawn");
    noResolution(r);
    expect(r.log).not.toContain("write home.after.json");
    expect(existsSync(join(r.rawDir, PROVENANCE_STOP_FILE))).toBe(false);
  });

  it("a failed group record reaches the spawn as a rejection; its latch is the durable stop", async () => {
    const r = rig({ failAt: "client.group.json" });
    const e = await guardedSpawn(r.ctx, fakeSpawn({}, r).fn).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProvenanceStopError);
    expect(read(join(r.rawDir, PROVENANCE_STOP_FILE))).toEqual({ code: "home.group-record: injected: client.group.json", cleanup: "confirmed", retryable: false });
    noResolution(r);
  });

  it("a failed readback record reaches the spawn as a rejection; its latch is the durable stop", async () => {
    const r = rig({ failAt: PROVENANCE_READBACK_FILE });
    const e = await guardedSpawn(r.ctx, fakeSpawn({}, r).fn).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProvenanceStopError);
    expect(read(join(r.rawDir, PROVENANCE_STOP_FILE))).toMatchObject({ code: `readback.record: injected: ${PROVENANCE_READBACK_FILE}` });
    noResolution(r);
  });

  it("a home change found by the terminal journal is a durable home stop", async () => {
    const r = rig();
    const e = await guardedSpawn(r.ctx, fakeSpawn({ touchHome: "added.txt" }, r).fn).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/stopped on the home journal: home\.violation: .*added \.claude\/added\.txt/);
    expect(read(join(r.rawDir, PROVENANCE_STOP_FILE))).toMatchObject({ code: "home.violation: changed .claude, added .claude/added.txt", cleanup: null });
    noResolution(r);
  });

  it("an unconfirmed cleanup with no other latch is a durable home stop", async () => {
    const r = rig();
    await expect(guardedSpawn(r.ctx, fakeSpawn({ cleanup: "unconfirmed" }, r).fn)).rejects.toThrow(/home\.cleanup\.unconfirmed/);
    expect(read(join(r.rawDir, PROVENANCE_STOP_FILE))).toMatchObject({ code: "home.cleanup.unconfirmed" });
    noResolution(r);
  });

  it("a transcript bound to another session is a durable home stop", async () => {
    const r = rig();
    await expect(guardedSpawn(r.ctx, fakeSpawn({ sid: OTHER }, r).fn)).rejects.toThrow(/home\.session-binding: an init event names a session the launch did not choose/);
    noResolution(r);
  });

  it("a failed terminal journal write is thrown as it is: no stop, no outcome", async () => {
    const r = rig({ failAt: "home.after.json" });
    await expect(guardedSpawn(r.ctx, fakeSpawn({}, r).fn)).rejects.toThrow("injected: home.after.json");
    noResolution(r);
    expect(existsSync(join(r.rawDir, PROVENANCE_STOP_FILE))).toBe(false);
  });

  it("the spawn's own latch wins over a journal finding and is recorded with the run's cleanup", async () => {
    const r = rig();
    const e = await guardedSpawn(r.ctx, fakeSpawn({ stop: "init.missing", touchHome: "added.txt" }, r).fn).catch((x: unknown) => x);
    expect((e as Error).message).toBe("continuity-run: c1#1 stopped on provenance: init.missing. The turn is discarded, not graded and not retried.");
    expect(read(join(r.rawDir, PROVENANCE_STOP_FILE))).toEqual({ code: "init.missing", cleanup: "confirmed", retryable: false });
    noResolution(r);
  });

  it("a failed stop write is thrown and leaves the unresolved intent for the next run to refuse on", async () => {
    const r = rig({ failAt: PROVENANCE_STOP_FILE });
    await expect(guardedSpawn(r.ctx, fakeSpawn({ stop: "init.missing" }, r).fn)).rejects.toThrow(`injected: ${PROVENANCE_STOP_FILE}`);
    noResolution(r);
  });

  it("a failed outcome write leaves no outcome and the intent unresolved", async () => {
    const r = rig({ failAt: PROVENANCE_OUTCOME_FILE });
    await expect(guardedSpawn(r.ctx, fakeSpawn({}, r).fn)).rejects.toThrow(`injected: ${PROVENANCE_OUTCOME_FILE}`);
    noResolution(r);
    expect(r.log.at(-1)).toBe(`write ${PROVENANCE_OUTCOME_FILE}`);
  });

  it("a failed resolution write leaves the outcome on disk and the intent unresolved: the state recovery resolves (C-F3)", async () => {
    const r = rig({ failAt: PROVENANCE_INTENT_FILE, failNth: 2 });
    await expect(guardedSpawn(r.ctx, fakeSpawn({}, r).fn)).rejects.toThrow(`injected: ${PROVENANCE_INTENT_FILE}`);
    expect(read(join(r.rawDir, PROVENANCE_INTENT_FILE))).toMatchObject({ state: "unresolved" });
    expect(read(join(r.rawDir, PROVENANCE_OUTCOME_FILE))).toMatchObject({ cleanup: "confirmed", sessionId: SID });
    expect(existsSync(join(r.rawDir, PROVENANCE_STOP_FILE))).toBe(false);
  });

  it("a guarded run whose cleanup is not confirmed, with no journal, is returned without an outcome or resolution", async () => {
    const r = rig({ journal: false });
    await expect(guardedSpawn(r.ctx, fakeSpawn({ cleanup: "unconfirmed" }, r).fn)).resolves.toMatchObject({ cleanup: "unconfirmed" });
    noResolution(r);
  });
});
