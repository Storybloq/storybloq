/**
 * ISS-958 S7: the one state writer. writeSessionSync validates the outgoing
 * bytes the way the strict reader would, writes the temp with a checked
 * length, fsyncs it, renames it over state.json and fsyncs the directory.
 * These are the named killers for SW01 to SW09 and the plan v4 section 8
 * characterisation of reader and writer side by side.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  StateWriteUndurableError,
  __stateWriteTesting,
  createSession,
  readSession,
  readSessionResilient,
  readSessionStrict,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import { CURRENT_SESSION_SCHEMA_VERSION, deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";

const SEAMS = ["state:validated", "state:tmp-written", "state:tmp-fsynced", "state:renamed", "state:dir-fsynced"];

const roots: string[] = [];
const original = { ...__stateWriteTesting };

afterEach(() => {
  Object.assign(__stateWriteTesting, original);
  while (roots.length) {
    try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function session(): { dir: string; state: FullSessionState } {
  const root = mkdtempSync(join(tmpdir(), "iss958-s7-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  const created = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = join(root, ".story", "sessions", created.sessionId);
  return { dir, state: readSession(dir)! };
}

const stateBytes = (dir: string) => readFileSync(join(dir, "state.json"));
const tmps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

/** Plant raw bytes, never through the writer under test. */
function plantRaw(dir: string, mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<string, unknown>;
  mutate(raw);
  writeFileSync(join(dir, "state.json"), JSON.stringify(raw, null, 2) + "\n");
}

describe("ISS-958 S7: the durable state writer", () => {
  it("SW09: a successful write hits all five seams once, in order, and bumps the revision by exactly one", () => {
    const { dir, state } = session();
    const points: string[] = [];
    __stateWriteTesting.at = (p) => { points.push(p); };
    const written = writeSessionSync(dir, state);
    expect(points).toEqual(SEAMS);
    expect(written.revision).toBe(state.revision + 1);
    expect(readSession(dir)!.revision).toBe(state.revision + 1);
    expect(tmps(dir)).toEqual([]);
  });

  it("SW03/SW04/SW05: the temp file is fsynced before the rename and the directory after it", () => {
    const { dir, state } = session();
    const trace: string[] = [];
    __stateWriteTesting.at = (p) => { trace.push(p); };
    __stateWriteTesting.fsync = (fd) => {
      trace.push(fstatSync(fd).isDirectory() ? "fsync:dir" : "fsync:file");
      original.fsync(fd);
    };
    writeSessionSync(dir, state);
    expect(trace).toEqual([
      "state:validated", "state:tmp-written", "fsync:file", "state:tmp-fsynced",
      "state:renamed", "fsync:dir", "state:dir-fsynced",
    ]);
  });

  it("SW01: an outgoing state the strict reader would refuse is refused before anything is written, with a plain error", () => {
    const { dir, state } = session();
    const before = stateBytes(dir);
    const points: string[] = [];
    __stateWriteTesting.at = (p) => { points.push(p); };
    let caught: unknown;
    try {
      writeSessionSync(dir, { ...state, sessionId: "not-a-uuid" } as unknown as FullSessionState);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StateWriteUndurableError);
    expect((caught as Error).message).toMatch(/refusing to write session state that the strict reader would refuse \(unreadable: schema\)/);
    expect(points).toEqual([]);
    expect(stateBytes(dir).equals(before)).toBe(true);
    expect(tmps(dir)).toEqual([]);
  });

  it("SW02: a short write of the temp file is a plain pre-rename failure and nothing is published", () => {
    const { dir, state } = session();
    const before = stateBytes(dir);
    __stateWriteTesting.writeSync = (fd, bytes) => writeSync(fd, bytes, 0, bytes.length - 1);
    let caught: unknown;
    try { writeSessionSync(dir, state); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StateWriteUndurableError);
    expect((caught as Error).message).toMatch(/state write was short/);
    expect(stateBytes(dir).equals(before)).toBe(true);
    expect(tmps(dir)).toEqual([]);
  });

  it("a failure at state:tmp-fsynced is plain and leaves the preimage byte-identical", () => {
    const { dir, state } = session();
    const before = stateBytes(dir);
    __stateWriteTesting.at = (p) => { if (p === "state:tmp-fsynced") throw new Error("injected tmp fsync failure"); };
    expect(() => writeSessionSync(dir, state)).toThrow("injected tmp fsync failure");
    expect(stateBytes(dir).equals(before)).toBe(true);
    expect(tmps(dir)).toEqual([]);
  });

  for (const seam of ["state:renamed", "state:dir-fsynced"]) {
    it(`SW06/SW07: a failure at ${seam} is a StateWriteUndurableError carrying the published state`, () => {
      const { dir, state } = session();
      __stateWriteTesting.at = (p) => { if (p === seam) throw new Error(`injected failure at ${seam}`); };
      let caught: unknown;
      try { writeSessionSync(dir, { ...state, state: "PLAN" } as FullSessionState); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(StateWriteUndurableError);
      const err = caught as StateWriteUndurableError;
      expect(err.published.revision).toBe(state.revision + 1);
      expect(err.observed).toBe("published-bytes");
      expect((err.cause as Error).message).toBe(`injected failure at ${seam}`);
      const onDisk = readSession(dir)!;
      expect(onDisk.revision).toBe(state.revision + 1);
      expect(onDisk.state).toBe("PLAN");
      expect(tmps(dir)).toEqual([]);
    });
  }

  it("SW08: `observed` classifies what one re-read finds, and never turns the failure into a success", () => {
    const cases: Array<{ name: string; at: (path: string) => void; want: string }> = [
      { name: "bytes replaced", at: (path) => writeFileSync(path, "{}\n"), want: "different-bytes" },
      { name: "file gone", at: (path) => unlinkSync(path), want: "unreadable" },
    ];
    for (const c of cases) {
      Object.assign(__stateWriteTesting, original);
      const { dir, state } = session();
      __stateWriteTesting.at = (p) => {
        if (p === "state:renamed") { c.at(join(dir, "state.json")); throw new Error("injected"); }
      };
      let caught: unknown;
      try { writeSessionSync(dir, state); } catch (err) { caught = err; }
      expect(caught, c.name).toBeInstanceOf(StateWriteUndurableError);
      expect((caught as StateWriteUndurableError).observed, c.name).toBe(c.want);
    }
  });
});

describe("ISS-958 S7: reader and writer refuse the same states (plan v4 section 8)", () => {
  const refusedAlike = (mutate: (raw: Record<string, unknown>) => void, readerFailure: Record<string, unknown>) => {
    const { dir } = session();
    plantRaw(dir, mutate);
    const read = readSessionStrict(dir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure).toMatchObject(readerFailure);
    // The writer is handed the same object the reader was, and refuses it
    // pre-rename with a plain error and nothing written.
    const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
    const before = stateBytes(dir);
    let caught: unknown;
    try { writeSessionSync(dir, raw); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StateWriteUndurableError);
    expect((caught as Error).message).toMatch(/refusing to write session state/);
    expect(stateBytes(dir).equals(before)).toBe(true);
    expect(tmps(dir)).toEqual([]);
  };

  it("an absent schemaVersion: the reader refuses as schema, and so does the writer", () => {
    refusedAlike((raw) => { delete raw.schemaVersion; }, { kind: "unreadable", reason: "schema" });
  });

  it("a present but unsupported schemaVersion: the reader says unsupported-version, and the writer refuses", () => {
    refusedAlike((raw) => { raw.schemaVersion = "one"; }, { kind: "unreadable", reason: "unsupported-version" });
  });

  it("a newer schemaVersion: the reader says version-skew, and the writer refuses", () => {
    refusedAlike((raw) => { raw.schemaVersion = CURRENT_SESSION_SCHEMA_VERSION + 1; }, { kind: "version-skew" });
  });

  it("the legacy branch strategy \"none\" reads as current and the write round-trips", () => {
    const { dir } = session();
    plantRaw(dir, (raw) => { raw.resolvedBranchStrategy = "none"; });
    const read = readSession(dir)!;
    expect(read.resolvedBranchStrategy).toBe("current");
    const written = writeSessionSync(dir, read);
    expect(readSession(dir)!.revision).toBe(written.revision);
    expect(readSession(dir)!.resolvedBranchStrategy).toBe("current");
  });

  it("an invalid lensReviewHistory disposition is dropped by the resilient read, and the write is accepted", () => {
    const { dir } = session();
    const entry = (disposition: string) => ({
      ticketId: "T-001", stage: "CODE_REVIEW", lens: "security", category: "c", severity: "minor",
      disposition, description: "d", dismissReason: null, timestamp: "2026-10-17T00:00:00.000Z",
    });
    plantRaw(dir, (raw) => { raw.lensReviewHistory = [entry("open"), entry("fixed")]; });
    expect(readSessionStrict(dir).ok).toBe(false);
    const read = readSessionResilient(dir)!;
    expect(read.lensReviewHistory.map((e) => e.disposition)).toEqual(["open"]);
    const written = writeSessionSync(dir, read);
    expect(readSession(dir)!.revision).toBe(written.revision);
  });
});
