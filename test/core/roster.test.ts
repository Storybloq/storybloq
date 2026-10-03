/**
 * T-507: the seat roster record (`.story/telemetry/roster/`), roster v1.
 *
 * Pure-ish core: file naming, monotonic lifecycle per generation, locked
 * read-modify-write, bounded read, Bus merge and the reaper. The Mod and the
 * CLI are thin over this module.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ROSTER_STALE_MS,
  ROSTER_TERMINAL_TTL_MS,
  ROSTER_TTL_MS,
  ROSTER_SCAN_CAP,
  ROSTER_RESULT_CAP,
  MAX_SEAT_ID_BYTES,
  rosterFileBase,
  seatIdOf,
  parseSeat,
  applySeatEvent,
  readRoster,
  mergeBusSeats,
  sweepRoster,
  rosterDirIfPresent,
  type RosterSeat,
  type RosterSeatEvent,
} from "../../src/core/roster.js";
import { acquireLock, releaseLock } from "../../src/presence/io.js";

// A seam on the lock primitive so one test can act "between" the sweeper's
// first look at a record and its re-read under the lock. Off unless a test
// arms it; the original implementation runs in every other case.
const lockHook = vi.hoisted(() => ({ onAcquired: null as null | ((lock: string, budgetMs: number | undefined) => void) }));
// A seam on directory enumeration so one test can hand the reader its entries
// in the reverse of whatever order the filesystem chose: a reader that sorts
// is unmoved, a reader that trusts enumeration order is not.
// ISS-1290: `lstatFail` makes lstat of exactly one path fail with an errno,
// delegating every other call, so the directory classification is checked on
// every platform (a chmod test cannot run as root).
const fsHook = vi.hoisted(() => ({ reverseListing: false, lstatFail: null as null | { path: string; code: string } }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((path: unknown, options?: unknown) => {
    const out = (orig.readdirSync as (p: unknown, o?: unknown) => unknown[])(path, options);
    return fsHook.reverseListing && Array.isArray(out) ? [...out].reverse() : out;
  }) as typeof orig.readdirSync;
  const lstatSync = ((path: unknown, options?: unknown) => {
    const fail = fsHook.lstatFail;
    if (fail !== null && String(path) === fail.path) {
      throw Object.assign(new Error(`${fail.code}: injected, lstat '${String(path)}'`), { code: fail.code });
    }
    return (orig.lstatSync as (p: unknown, o?: unknown) => unknown)(path, options);
  }) as typeof orig.lstatSync;
  return { ...orig, default: { ...orig, readdirSync, lstatSync }, readdirSync, lstatSync };
});
vi.mock("../../src/presence/io.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/presence/io.js")>();
  return {
    ...orig,
    acquireLock: (lock: string, budgetMs?: number): boolean => {
      const ok = orig.acquireLock(lock, budgetMs);
      if (ok && lockHook.onAcquired !== null) lockHook.onAcquired(lock, budgetMs);
      return ok;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fsHook.lstatFail = null;
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, ".story", "telemetry"), 0o755); } catch { /* absent */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roster-"));
  roots.push(root);
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), "{}");
  return root;
}

const T0 = Date.parse("2026-09-15T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function start(overrides: Partial<RosterSeatEvent> = {}): RosterSeatEvent {
  return {
    kind: "start",
    client: "claude",
    clientTaskId: "task-a",
    agentId: null,
    sessionId: "task-a",
    description: null,
    ...overrides,
  };
}

describe("seat identity and file naming", () => {
  it("derives the seat id from the tuple; the task id grammar forbids '/', so the form is unambiguous", () => {
    expect(seatIdOf("claude", "task-a", null)).toBe("claude:task-a");
    expect(seatIdOf("codex", "task-a", "agent/1")).toBe("codex:task-a/agent/1");
    expect(MAX_SEAT_ID_BYTES).toBe(6 + 1 + 128 + 1 + 128);
  });

  it("names the file by a sha256 of the canonical tuple: fixed length, injective across the delimiter collisions", () => {
    const a = rosterFileBase("claude", "a", "b.c");
    const b = rosterFileBase("claude", "a.b", "c");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(createHash("sha256").update(JSON.stringify(["claude", "a", "b.c"])).digest("hex"));
    const longId = "x".repeat(128);
    expect(rosterFileBase("codex", longId, longId)).toHaveLength(64);
  });
});

describe("applySeatEvent: lifecycle per generation", () => {
  it("start creates a running seat at generation 1", () => {
    const seat = applySeatEvent(null, start(), iso(T0));
    expect(seat).toMatchObject({
      schema: "storybloq-roster/v1",
      seatId: "claude:task-a",
      client: "claude",
      clientTaskId: "task-a",
      agentId: null,
      sessionId: "task-a",
      state: "running",
      provenance: "mod",
      generation: 1,
      startedAt: iso(T0),
      lastSeenAt: iso(T0),
    });
  });

  it("a restart (start again) advances the generation in place and resets to running (ISS-1205 acceptance 1)", () => {
    const first = applySeatEvent(null, start(), iso(T0));
    const ended = applySeatEvent(first, { kind: "end", state: "completed", generation: 1 }, iso(T0 + 1000));
    const again = applySeatEvent(ended, start({ sessionId: "task-a-2" }), iso(T0 + 2000));
    expect(again).not.toBeNull();
    expect(again!.seatId).toBe(first.seatId);
    expect(again!.generation).toBe(2);
    expect(again!.state).toBe("running");
    expect(again!.sessionId).toBe("task-a-2");
    expect(again!.startedAt).toBe(iso(T0 + 2000));
  });

  it("a heartbeat advances lastSeenAt only; a heartbeat cannot resurrect a terminal seat", () => {
    const running = applySeatEvent(null, start(), iso(T0));
    const beat = applySeatEvent(running, { kind: "heartbeat", generation: 1 }, iso(T0 + 5000));
    expect(beat!.lastSeenAt).toBe(iso(T0 + 5000));
    expect(beat!.startedAt).toBe(iso(T0));
    const killed = applySeatEvent(beat, { kind: "end", state: "killed", generation: 1 }, iso(T0 + 6000));
    const late = applySeatEvent(killed, { kind: "heartbeat", generation: 1 }, iso(T0 + 7000));
    expect(late).toBeNull();
  });

  it("a start that repeats the running session is idempotent: same generation, startedAt kept, lastSeenAt advanced", () => {
    const first = applySeatEvent(null, start(), iso(T0));
    const again = applySeatEvent(first, start(), iso(T0 + 500));
    expect(again!.generation).toBe(1);
    expect(again!.startedAt).toBe(iso(T0));
    expect(again!.lastSeenAt).toBe(iso(T0 + 500));
  });

  it("a heartbeat or an end naming a replaced generation is refused; lastSeenAt never moves backward", () => {
    const g1 = applySeatEvent(null, start(), iso(T0));
    const g1done = applySeatEvent(g1, { kind: "end", state: "completed", generation: 1 }, iso(T0 + 1));
    const g2 = applySeatEvent(g1done, start({ sessionId: "task-a-2" }), iso(T0 + 2))!;
    expect(g2.generation).toBe(2);
    expect(applySeatEvent(g2, { kind: "end", state: "killed", generation: 1 }, iso(T0 + 3))).toBeNull();
    expect(applySeatEvent(g2, { kind: "heartbeat", generation: 1 }, iso(T0 + 3))).toBeNull();
    expect(applySeatEvent(g2, { kind: "heartbeat", generation: 2 }, iso(T0 + 3))!.lastSeenAt).toBe(iso(T0 + 3));
    const late = applySeatEvent(g2, { kind: "heartbeat", generation: 2 }, iso(T0 - 1000));
    expect(late!.lastSeenAt).toBe(iso(T0 + 2));
    // The generation is required, not advisory: an event without one, or with a
    // non-positive one, is an input error, never a write against the current generation.
    expect(() => applySeatEvent(g2, { kind: "heartbeat" } as never, iso(T0 + 4))).toThrow(/generation/);
    expect(() => applySeatEvent(g2, { kind: "end", state: "completed" } as never, iso(T0 + 4))).toThrow(/generation/);
    // Exact match, not "at least": a generation from the future is refused too.
    expect(applySeatEvent(g2, { kind: "heartbeat", generation: 3 }, iso(T0 + 4))).toBeNull();
    expect(applySeatEvent(g2, { kind: "end", state: "completed", generation: 3 }, iso(T0 + 4))).toBeNull();
    expect(() => applySeatEvent(g2, { kind: "end", state: "completed", generation: 0 }, iso(T0 + 4))).toThrow(/generation/);
    expect(() => applySeatEvent(g2, { kind: "end", state: "completed", generation: 1.5 }, iso(T0 + 4))).toThrow(/generation/);
  });

  it("end on a terminal seat is refused; heartbeat and end on a missing seat are refused", () => {
    const running = applySeatEvent(null, start(), iso(T0));
    const done = applySeatEvent(running, { kind: "end", state: "completed", generation: 1 }, iso(T0 + 1));
    expect(applySeatEvent(done, { kind: "end", state: "failed", generation: 1 }, iso(T0 + 2))).toBeNull();
    expect(applySeatEvent(null, { kind: "heartbeat", generation: 1 }, iso(T0))).toBeNull();
    expect(applySeatEvent(null, { kind: "end", state: "completed", generation: 1 }, iso(T0))).toBeNull();
  });

  it("a start without a sessionId is refused: nothing else tells a duplicate from a restart", () => {
    expect(() => applySeatEvent(null, start({ sessionId: null as never }), iso(T0))).toThrow(/sessionId/);
    expect(() => applySeatEvent(null, start({ sessionId: "" }), iso(T0))).toThrow(/sessionId/);
    expect(() => applySeatEvent(null, start({ sessionId: "a\u0000b" }), iso(T0))).toThrow(/sessionId/);
  });

  it("a duplicate start for a session that has already ended is refused; only a different session restarts the seat", () => {
    const running = applySeatEvent(null, start(), iso(T0));
    const done = applySeatEvent(running, { kind: "end", state: "completed", generation: 1 }, iso(T0 + 1));
    // The delayed duplicate of session task-a must not resurrect it as generation 2.
    expect(applySeatEvent(done, start(), iso(T0 + 2))).toBeNull();
    expect(applySeatEvent(done, start({ sessionId: "task-a-2" }), iso(T0 + 2))!.generation).toBe(2);
  });

  it("refuses a non-canonical clock and a restart dated before the record's lastSeenAt", () => {
    expect(() => applySeatEvent(null, start(), "not a date")).toThrow(/canonical/);
    expect(() => applySeatEvent(null, start(), "2026-09-15T00:00:00Z")).toThrow(/canonical/); // parses, but is not the canonical form
    const running = applySeatEvent(null, start(), iso(T0 + 1000));
    // A delayed start (new session, older timestamp) must not replace the newer session.
    expect(applySeatEvent(running, start({ sessionId: "task-a-2" }), iso(T0))).toBeNull();
    // At or after lastSeenAt the restart is honoured.
    expect(applySeatEvent(running, start({ sessionId: "task-a-2" }), iso(T0 + 1000))!.generation).toBe(2);
  });

  it("bounds every string by bytes and refuses a start over the caps", () => {
    const okDesc = "é".repeat(100); // 200 bytes
    expect(applySeatEvent(null, start({ agentId: "a1", description: okDesc }), iso(T0))!.description).toBe(okDesc);
    expect(() => applySeatEvent(null, start({ agentId: "a1", description: "é".repeat(101) }), iso(T0))).toThrow(/description/);
    expect(() => applySeatEvent(null, start({ agentId: "a".repeat(129) }), iso(T0))).toThrow(/agentId/);
    expect(() => applySeatEvent(null, start({ clientTaskId: "bad/id" }), iso(T0))).toThrow(/clientTaskId/);
    expect(() => applySeatEvent(null, start({ agentId: "" }), iso(T0))).toThrow(/agentId/);
  });
});

describe("parseSeat", () => {
  it("round-trips a record and refuses one whose tuple does not match its file name", () => {
    const seat = applySeatEvent(null, start({ agentId: "ag-1", description: "reads README" }), iso(T0));
    const text = JSON.stringify(seat);
    expect(parseSeat(text, rosterFileBase("claude", "task-a", "ag-1"))).toEqual(seat);
    expect(parseSeat(text, rosterFileBase("claude", "task-a", "ag-2"))).toBeNull();
    expect(parseSeat("not json", rosterFileBase("claude", "task-a", "ag-1"))).toBeNull();
    expect(parseSeat(JSON.stringify({ ...seat, state: "dancing" }), rosterFileBase("claude", "task-a", "ag-1"))).toBeNull();
  });

  it("mirrors the writer's invariants: no bus seat on disk, generation at least 1, non-empty sessionId, no control characters, lastSeenAt not before startedAt", () => {
    const seat = applySeatEvent(null, start({ agentId: "ag-1" }), iso(T0))!;
    const base = rosterFileBase("claude", "task-a", "ag-1");
    const planted = (over: Record<string, unknown>) => parseSeat(JSON.stringify({ ...seat, ...over }), base);
    expect(planted({ provenance: "bus" })).toBeNull();
    expect(planted({ generation: 0 })).toBeNull();
    expect(planted({ sessionId: "" })).toBeNull();
    expect(planted({ sessionId: null })).toBeNull();
    expect(planted({ sessionId: "a\u0007b" })).toBeNull();
    expect(planted({ lastSeenAt: iso(T0 - 1) })).toBeNull();
    const ctl = applySeatEvent(null, start({ agentId: "ag" }), iso(T0))!;
    expect(parseSeat(JSON.stringify({ ...ctl, agentId: "ag\u0001", seatId: "claude:task-a/ag\u0001" }), rosterFileBase("claude", "task-a", "ag\u0001"))).toBeNull();
  });
});

describe("readRoster: on disk, bounded, sorted, stale-marked", () => {
  it("creates nothing when the roster dir is absent and reports zero", () => {
    const root = makeRoot();
    const view = readRoster(root, T0);
    expect(view).toEqual({ seats: [], live: 0, stale: 0, terminal: 0, scanTruncated: false, resultTruncated: false, diagnostics: [] });
    expect(existsSync(join(root, ".story", "telemetry", "roster"))).toBe(false);
  });

  it("writes through the locked path, reads back, marks stale past ROSTER_STALE_MS and hides nothing (list shows terminal too)", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    expect(upsertSeat(root, start(), iso(T0))).toMatchObject({ ok: true, seatId: "claude:task-a" });
    expect(upsertSeat(root, start({ clientTaskId: "task-b", sessionId: "task-b" }), iso(T0))).toMatchObject({ ok: true });
    expect(upsertSeat(root, { kind: "end", state: "completed", generation: 1, client: "claude", clientTaskId: "task-b", agentId: null }, iso(T0 + 1))).toMatchObject({ ok: true });
    const view = readRoster(root, T0 + ROSTER_STALE_MS + 1);
    const a = view.seats.find((s) => s.seatId === "claude:task-a")!;
    const b = view.seats.find((s) => s.seatId === "claude:task-b")!;
    expect(a.stale).toBe(true);
    expect(a.state).toBe("running");
    expect(b.state).toBe("completed");
    expect(b.stale).toBe(false);
    // A stale seat is running but not live: the three counts partition the list.
    expect(view.live).toBe(0);
    expect(view.stale).toBe(1);
    expect(view.terminal).toBe(1);
  });

  it("refuses a heartbeat for a seat that was never started and reports why", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    const r = upsertSeat(root, { kind: "heartbeat", generation: 1, client: "claude", clientTaskId: "ghost", agentId: null }, iso(T0));
    expect(r).toMatchObject({ ok: false, reason: "refused-transition" });
    // Input errors are reported before any directory or lock is touched.
    expect(upsertSeat(root, { kind: "heartbeat", client: "claude", clientTaskId: "ghost", agentId: null } as never, iso(T0))).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(upsertSeat(root, start(), "yesterday")).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(existsSync(join(root, ".story", "telemetry", "roster"))).toBe(false);
  });

  it("reports contention instead of a false write when the record lock is held", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    const dir = rosterDirIfPresent(root)!;
    const lock = join(dir, `${rosterFileBase("claude", "task-a", null)}.lock`);
    expect(acquireLock(lock)).toBe(true);
    try {
      expect(upsertSeat(root, { kind: "heartbeat", generation: 1, client: "claude", clientTaskId: "task-a", agentId: null }, iso(T0 + 1))).toMatchObject({ ok: false, reason: "skipped-contention" });
    } finally {
      releaseLock(lock);
    }
  });

  it("scans a bounded, sorted population, keeps the newest ROSTER_RESULT_CAP, and says when either bound cut", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    // The real seat is written FIRST, so enumeration order alone would keep
    // it; only a name-sorted scan lets the junk (named to sort before every
    // hex hash) push it past the cap. The reader must then say so, not report
    // zero seats as the truth. Fresh junk is not reaped (mtime under the TTL).
    upsertSeat(root, start(), iso(T0));
    const dir = rosterDirIfPresent(root)!;
    expect(readRoster(root, T0).seats).toHaveLength(1);
    for (let i = 0; i < ROSTER_SCAN_CAP + 5; i++) {
      writeFileSync(join(dir, `.junk-${String(i).padStart(4, "0")}.json`), "{}");
    }
    const view = readRoster(root, T0);
    expect(view.scanTruncated).toBe(true);
    expect(view.seats).toEqual([]);
    // The same answer when the filesystem hands the entries back reversed.
    fsHook.reverseListing = true;
    try {
      expect(readRoster(root, T0).seats).toEqual([]);
    } finally {
      fsHook.reverseListing = false;
    }
    expect(view.diagnostics.length).toBeGreaterThan(0);
    // An unreadable file older than the long TTL is reaped by mtime; a fresh one never is.
    expect(readdirSync(dir).filter((n) => n.startsWith(".junk")).length).toBe(ROSTER_SCAN_CAP + 5);
    // The cap on results is separate from the scan cap.
    expect(ROSTER_RESULT_CAP).toBeLessThanOrEqual(ROSTER_SCAN_CAP);
  });

  it("keeps the newest ROSTER_RESULT_CAP seats by lastSeenAt and flags resultTruncated", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    for (let i = 0; i < ROSTER_RESULT_CAP + 3; i++) {
      upsertSeat(root, start({ clientTaskId: `t-${i}`, sessionId: `t-${i}` }), iso(T0 + i));
    }
    const view = readRoster(root, T0 + 1000);
    expect(view.seats).toHaveLength(ROSTER_RESULT_CAP);
    expect(view.resultTruncated).toBe(true);
    expect(view.seats.some((s) => s.clientTaskId === "t-0")).toBe(false);
    expect(view.seats.some((s) => s.clientTaskId === `t-${ROSTER_RESULT_CAP + 2}`)).toBe(true);
  });

  it("never reads through a symlinked telemetry level", async () => {
    const root = makeRoot();
    const elsewhere = mkdtempSync(join(tmpdir(), "roster-elsewhere-"));
    roots.push(elsewhere);
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".story", "telemetry", "roster"));
    writeFileSync(join(elsewhere, `${rosterFileBase("claude", "task-a", null)}.json`), JSON.stringify(applySeatEvent(null, start(), iso(T0))));
    expect(rosterDirIfPresent(root)).toBeNull();
    expect(readRoster(root, T0).seats).toEqual([]);
    const { upsertSeat } = await import("../../src/core/roster.js");
    expect(upsertSeat(root, start(), iso(T0))).toMatchObject({ ok: false });
  });
});

describe("mergeBusSeats", () => {
  const seatA: RosterSeat = applySeatEvent(null, start({ client: "codex", clientTaskId: "cx-1", sessionId: "cx-1" }), iso(T0))!;
  const ep = (over: Partial<{ endpointId: string; clientTaskId: string; client: "claude" | "codex"; joinedAt: string; lastSeenAt: string; lastWakeAt: string | null; retiredAt: string | null; liveness: "attached" | "offline" | "unknown" }> = {}) => ({
    endpointId: "e-1",
    clientTaskId: "cx-1",
    client: "codex" as const,
    joinedAt: iso(T0),
    lastSeenAt: iso(T0),
    lastWakeAt: null,
    retiredAt: null,
    liveness: "attached" as const,
    ...over,
  });

  it("a fresh running mod seat wins; the attached endpoint is kept as a source ref", () => {
    const [v] = mergeBusSeats([seatA], [ep({ lastSeenAt: iso(T0 + 1000) })], T0 + 2000).seats;
    expect(v!.provenance).toBe("mod");
    expect(v!.sourceRefs.busEndpointIds).toEqual(["e-1"]);
    expect(v!.lastSeenAt).toBe(iso(T0));
  });

  it("a stale mod seat with a newer attached endpoint reads as live with provenance bus and the endpoint's observation as lastSeenAt", () => {
    const now = T0 + ROSTER_STALE_MS + 5000;
    const [v] = mergeBusSeats([seatA], [ep({ lastWakeAt: iso(now - 1000), lastSeenAt: iso(T0) })], now).seats;
    expect(v!.provenance).toBe("bus");
    expect(v!.state).toBe("running");
    expect(v!.stale).toBe(false);
    expect(v!.lastSeenAt).toBe(iso(now - 1000));
  });

  it("a terminal mod seat with a newer attached endpoint reads as live via bus; an older endpoint leaves it terminal", () => {
    const done = applySeatEvent(seatA, { kind: "end", state: "completed", generation: 1 }, iso(T0 + 100))!;
    const newer = mergeBusSeats([done], [ep({ lastSeenAt: iso(T0 + 200) })], T0 + 300).seats[0]!;
    expect(newer.state).toBe("running");
    expect(newer.provenance).toBe("bus");
    const older = mergeBusSeats([done], [ep({ lastSeenAt: iso(T0 + 50) })], T0 + 300).seats[0]!;
    expect(older.state).toBe("completed");
    expect(older.provenance).toBe("mod");
  });

  it("an identity with no mod seat and an attached endpoint is a synthesized bus seat with sessionId null; offline, unknown and retired endpoints synthesize nothing", () => {
    const only = mergeBusSeats([], [ep({ clientTaskId: "cx-9", endpointId: "e-9", liveness: "attached" })], T0 + 1).seats;
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ seatId: "codex:cx-9", client: "codex", clientTaskId: "cx-9", sessionId: null, provenance: "bus", state: "running", generation: 0 });
    expect(only[0]!.sourceRefs.busEndpointIds).toEqual(["e-9"]);
    expect(mergeBusSeats([], [ep({ liveness: "offline" })], T0).seats).toEqual([]);
    expect(mergeBusSeats([], [ep({ liveness: "unknown" })], T0).seats).toEqual([]);
    expect(mergeBusSeats([], [ep({ retiredAt: iso(T0) })], T0).seats).toEqual([]);
  });

  it("keeps every attached endpoint id for one identity (succession duplicates stay visible), bounded to four", () => {
    const eps = [1, 2, 3, 4, 5].map((i) => ep({ endpointId: `e-${i}` }));
    const [v] = mergeBusSeats([], eps, T0 + 1).seats;
    expect(v!.sourceRefs.busEndpointIds).toEqual(["e-1", "e-2", "e-3", "e-4"]);
  });

  it("the merged view is bounded to ROSTER_RESULT_CAP newest seats and says when it cut", () => {
    const eps = Array.from({ length: ROSTER_RESULT_CAP + 2 }, (_, i) => ep({ clientTaskId: `cx-${i}`, endpointId: `e-${i}`, lastSeenAt: iso(T0 + i) }));
    const merged = mergeBusSeats([], eps, T0 + 1000);
    expect(merged.seats).toHaveLength(ROSTER_RESULT_CAP);
    expect(merged.resultTruncated).toBe(true);
    expect(merged.seats[0]!.clientTaskId).toBe(`cx-${ROSTER_RESULT_CAP + 1}`);
    expect(merged.seats.some((s) => s.clientTaskId === "cx-0")).toBe(false);
    expect(merged.scanTruncated).toBe(false);
  });

  it("the endpoint input is capped at ROSTER_SCAN_CAP by endpointId order, not caller order, and the cut is reported", () => {
    const pad = (i: number) => String(i).padStart(4, "0");
    // The last endpoint inside the cap (by id) is fresher than the crowd so
    // the RESULT cap cannot hide it; the first one beyond the cap is fresher
    // still, so only the SCAN cap can explain its absence.
    const last = ROSTER_SCAN_CAP - 1;
    const eps = Array.from({ length: ROSTER_SCAN_CAP + 3 }, (_, i) =>
      ep({ clientTaskId: `cx-${pad(i)}`, endpointId: `e-${pad(i)}`, lastSeenAt: iso(i === last ? T0 + 1000 : i > last ? T0 + 2000 : T0) }),
    );
    const forward = mergeBusSeats([], eps, T0 + 3000);
    const backward = mergeBusSeats([], [...eps].reverse(), T0 + 3000);
    expect(forward.scanTruncated).toBe(true);
    expect(backward.scanTruncated).toBe(true);
    const ids = (m: { seats: readonly { seatId: string }[] }) => m.seats.map((s) => s.seatId);
    expect(ids(backward)).toEqual(ids(forward));
    expect(ids(forward)).toContain(`codex:cx-${pad(last)}`);
    expect(ids(forward)).not.toContain(`codex:cx-${pad(last + 1)}`);
    expect(ids(forward)).not.toContain(`codex:cx-${pad(ROSTER_SCAN_CAP + 2)}`);
  });
});

describe("sweepRoster", () => {
  it("reaps an old temp file only when the process named in it is gone; a paused writer's temp file and an unparseable name survive", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    const dir = rosterDirIfPresent(root)!;
    // A dead pid: a pid this high is unallocated on every supported platform.
    const dead = join(dir, ".tmp-2147483000-1-1");
    // This very process, paused mid-write.
    const mine = join(dir, `.tmp-${process.pid}-1-1`);
    // A temp name the writer never produces: not ours to judge.
    const odd = join(dir, ".tmp-unknown");
    for (const p of [dead, mine, odd]) {
      writeFileSync(p, "{");
      const old = new Date(T0 - 60_000);
      utimesSync(p, old, old);
    }
    sweepRoster(dir, T0);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    // Fresh temp files survive even with a dead owner.
    writeFileSync(dead, "{");
    sweepRoster(dir, Date.now());
    expect(existsSync(dead)).toBe(true);
  });

  it("removes terminal seats past ROSTER_TERMINAL_TTL_MS and running seats unheard past ROSTER_TTL_MS, under the lock, re-checking before unlink", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start({ clientTaskId: "old-done", sessionId: "x" }), iso(T0));
    upsertSeat(root, { kind: "end", state: "completed", generation: 1, client: "claude", clientTaskId: "old-done", agentId: null }, iso(T0 + 1));
    upsertSeat(root, start({ clientTaskId: "old-running", sessionId: "y" }), iso(T0));
    // Started under the terminal TTL so this write's own best-effort sweep does
    // not reap old-done before the assertions below see it go.
    upsertSeat(root, start({ clientTaskId: "fresh", sessionId: "z" }), iso(T0 + ROSTER_TERMINAL_TTL_MS - 1));
    const dir = rosterDirIfPresent(root)!;
    // A held lock protects a record from the reaper.
    const lock = join(dir, `${rosterFileBase("claude", "old-running", null)}.lock`);
    expect(acquireLock(lock)).toBe(true);
    let removed: number;
    try {
      removed = sweepRoster(dir, T0 + ROSTER_TTL_MS + 1);
    } finally {
      releaseLock(lock);
    }
    expect(removed).toBe(1); // old-done only: old-running was locked
    expect(sweepRoster(dir, T0 + ROSTER_TTL_MS + 1)).toBe(1); // now old-running
    const left = readdirSync(dir).filter((n) => n.endsWith(".json"));
    expect(left).toEqual([`${rosterFileBase("claude", "fresh", null)}.json`]);
    expect(ROSTER_TERMINAL_TTL_MS).toBeLessThan(ROSTER_TTL_MS);
  });

  it("never reaps a live lock directory itself: a held lock keeps both the lock and its expired record", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    const dir = rosterDirIfPresent(root)!;
    const lock = join(dir, `${rosterFileBase("claude", "task-a", null)}.lock`);
    // A lock a writer holds right now (fresh mtime). Only the lock primitive's
    // own staleness rule (30 s, in presence/io.ts) may ever clear a lock; the
    // sweeper has no rule of its own.
    mkdirSync(lock);
    expect(sweepRoster(dir, T0 + ROSTER_TTL_MS * 2)).toBe(0);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(dir, `${rosterFileBase("claude", "task-a", null)}.json`))).toBe(true);
    rmSync(lock, { recursive: true });
  });

  it("re-reads under the lock: a record refreshed between the first look and the lock survives the sweep", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    const dir = rosterDirIfPresent(root)!;
    const base = rosterFileBase("claude", "task-a", null);
    const file = join(dir, `${base}.json`);
    const now = T0 + ROSTER_TTL_MS + 1;
    const acquired: Array<{ lock: string; budgetMs: number | undefined }> = [];
    // The moment the sweeper takes this record's lock (it already judged the
    // record expired), a writer's refresh lands: the record is current again.
    lockHook.onAcquired = (lock, budgetMs) => {
      acquired.push({ lock, budgetMs });
      if (lock !== join(dir, `${base}.lock`)) return;
      const current = parseSeat(readFileSync(file, "utf-8"), base)!;
      writeFileSync(file, JSON.stringify(applySeatEvent(current, { kind: "heartbeat", generation: 1 }, iso(now))));
    };
    try {
      expect(sweepRoster(dir, now)).toBe(0);
    } finally {
      lockHook.onAcquired = null;
    }
    // Exactly one take of this record's lock, and a non-blocking one: a sweep
    // must never wait out the lock budget once per contended record.
    expect(acquired).toEqual([{ lock: join(dir, `${base}.lock`), budgetMs: 0 }]);
    expect(existsSync(file)).toBe(true);
    expect(parseSeat(readFileSync(file, "utf-8"), base)!.lastSeenAt).toBe(iso(now));
  });

  it("a terminal seat younger than ROSTER_TERMINAL_TTL_MS survives", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    upsertSeat(root, { kind: "end", state: "killed", generation: 1, client: "claude", clientTaskId: "task-a", agentId: null }, iso(T0 + 1));
    const dir = rosterDirIfPresent(root)!;
    expect(sweepRoster(dir, T0 + ROSTER_TERMINAL_TTL_MS - 1)).toBe(0);
    expect(sweepRoster(dir, T0 + ROSTER_TERMINAL_TTL_MS + 2)).toBe(1);
  });

  it("uses the record's own lastSeenAt, not the file mtime", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    const dir = rosterDirIfPresent(root)!;
    const file = join(dir, `${rosterFileBase("claude", "task-a", null)}.json`);
    utimesSync(file, new Date(T0 + ROSTER_TTL_MS * 2), new Date(T0 + ROSTER_TTL_MS * 2));
    expect(sweepRoster(dir, T0 + ROSTER_TTL_MS + 1)).toBe(1);
  });
});

describe("contacts.json is not read by any code path (ISS-1205 acceptance 4)", () => {
  it("a legacy contacts.json, at the ledger root or inside the roster dir, never becomes a seat", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    upsertSeat(root, start(), iso(T0));
    // A record that would be a perfectly valid seat under its own hash name,
    // planted under the legacy file name in both places a reader could look.
    const sentinel = applySeatEvent(null, start({ clientTaskId: "legacy-contact", sessionId: "legacy-contact" }), iso(T0))!;
    writeFileSync(join(root, ".story", "contacts.json"), JSON.stringify({ contacts: [sentinel] }));
    writeFileSync(join(rosterDirIfPresent(root)!, "contacts.json"), JSON.stringify(sentinel));
    const view = readRoster(root, T0);
    expect(view.seats.map((s) => s.seatId)).toEqual(["claude:task-a"]);
    expect(view.diagnostics).toEqual(["1 roster entry unreadable or invalid"]);
    expect(mergeBusSeats(view.seats, [], T0).seats.map((s) => s.seatId)).toEqual(["claude:task-a"]);
  });

  it("no source file under src/ mentions contacts.json", async () => {
    const { readdirSync: rd, readFileSync, statSync } = await import("node:fs");
    const srcRoot = join(__dirname, "..", "..", "src");
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const name of rd(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|md|json)$/.test(name) && readFileSync(p, "utf-8").includes("contacts.json")) hits.push(p);
      }
    };
    walk(srcRoot);
    expect(hits).toEqual([]);
  });
});

describe("readRoster: structured read uncertainty (ISS-1290)", () => {
  it("U0: an lstat failure on the roster level is a roster-directory uncertainty, not absence (runs everywhere)", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "telemetry", "roster"), { recursive: true });
    fsHook.lstatFail = { path: join(root, ".story", "telemetry", "roster"), code: "EACCES" };
    const view = readRoster(root, T0);
    expect(view.seats).toEqual([]);
    expect(view.readUncertainty).toHaveLength(1);
    expect(view.readUncertainty![0]!.source).toBe("roster-directory");
    expect(view.readUncertainty![0]!.cause).toMatch(/roster.*EACCES/);
    expect(view.diagnostics).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("U1: a telemetry level that cannot be searched (chmod 000) is a roster-directory uncertainty naming EACCES", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "telemetry", "roster"), { recursive: true });
    chmodSync(join(root, ".story", "telemetry"), 0o000);
    const view = readRoster(root, T0);
    expect(view.seats).toEqual([]);
    expect(view.readUncertainty?.map((u) => u.source)).toEqual(["roster-directory"]);
    expect(view.readUncertainty![0]!.cause).toMatch(/EACCES/);
    expect(view.diagnostics).toEqual([]);
  });

  it("U2: a symlinked roster directory is a roster-directory uncertainty: not a real directory", () => {
    const root = makeRoot();
    const elsewhere = mkdtempSync(join(tmpdir(), "roster-elsewhere-"));
    roots.push(elsewhere);
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".story", "telemetry", "roster"));
    const view = readRoster(root, T0);
    expect(view.readUncertainty).toEqual([{ source: "roster-directory", cause: expect.stringMatching(/not a real directory/) }]);
  });

  it("U3: an absent telemetry directory is genuinely empty: no readUncertainty key at all", () => {
    const root = makeRoot();
    const view = readRoster(root, T0);
    expect("readUncertainty" in view).toBe(false);
  });

  it("U4: an invalid record is a roster-entry uncertainty; the diagnostics string is unchanged", async () => {
    const root = makeRoot();
    const { upsertSeat } = await import("../../src/core/roster.js");
    expect(upsertSeat(root, start(), iso(T0)).ok).toBe(true);
    writeFileSync(join(root, ".story", "telemetry", "roster", `${"0".repeat(64)}.json`), "{ not json");
    const view = readRoster(root, T0);
    expect(view.diagnostics).toEqual(["1 roster entry unreadable or invalid"]);
    expect(view.readUncertainty).toEqual([{ source: "roster-entry", cause: "1 unreadable or invalid" }]);
    expect(view.seats.map((s) => s.clientTaskId)).toEqual(["task-a"]);
  });
});
