/**
 * T-450 step 7b.4 -- the heartbeat GENERATION lifecycle.
 *
 * Every test here exists because a takeover binds a session to a NEW telemetry
 * generation while the legacy directory keeps the DEAD owner's leftovers. Every
 * accessor that still reads the legacy directory unconditionally answers about
 * the displaced owner, and the one that matters -- the waker's "a live client
 * still owns this session" check -- fails in the direction that spawns a SECOND
 * driver against a session someone is actively driving.
 *
 * The tri-state is the other half. A nullable accessor cannot say "I could not
 * tell", so every read fault (EACCES, a non-regular file, garbage content)
 * arrives as "nobody is there" and the waker spawns anyway. `unusable` is never
 * `absent`, and it never falls back to the legacy directory: falling back
 * consults the very owner the takeover displaced.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  telemetryDirPath,
  newHeartbeatGenerationId,
  readOwnerHeartbeat,
  resolveOwnerTelemetry,
  writeShutdownMarker,
  spawnAliveSidecarFor,
  readAliveTimestamp,
  killSidecar,
} from "../../src/autonomous/liveness.js";
import { collectProbes } from "../../src/autonomous/health-model.js";
import { refreshStatusForSession } from "../../src/autonomous/status-writer.js";

/**
 * Root-run would defeat every permission-based case, and Windows does not
 * enforce POSIX bits at all. Skip rather than lie: a chmod that does not deny
 * would exercise a different branch under the same test name.
 */
const canDenyRead = typeof process.getuid === "function" && process.getuid() !== 0;
/** Symlink creation needs a privilege that is not granted by default on Windows. */
const canSymlink = process.platform !== "win32";

describe("T-450 7b.4: owner heartbeat, generation-scoped and tri-state", () => {
  let tmpDir: string;
  let sessionDir: string;

  const writeState = (extra: Record<string, unknown> = {}): void => {
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ sessionId: "s-1", state: "IMPLEMENT", status: "active", ...extra }),
    );
  };

  const generationDir = (id: string): string =>
    join(telemetryDirPath(sessionDir), "generations", id);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "owner-heartbeat-"));
    sessionDir = join(tmpDir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    // Restore any denied directory so cleanup can actually remove the tree.
    for (const dir of [telemetryDirPath(sessionDir), sessionDir, tmpDir]) {
      try { chmodSync(dir, 0o755); } catch { /* never existed */ }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  // -------------------------------------------------------------------------
  // Which directory is consulted
  // -------------------------------------------------------------------------

  describe("directory resolution", () => {
    it("with NO generation field reads the legacy directory, exactly as before", () => {
      writeState();
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");

      expect(resolveOwnerTelemetry(sessionDir)).toEqual({ kind: "legacy", dir: tDir });
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "alive", at: 1712847600000 });
    });

    it("with a generation reads THAT directory and ignores the displaced owner's legacy heartbeat", () => {
      const id = newHeartbeatGenerationId();
      writeState({ heartbeatGeneration: id });
      const legacy = telemetryDirPath(sessionDir);
      mkdirSync(legacy, { recursive: true });
      // The DEAD owner's stale heartbeat. Reading it is the double-driver bug.
      writeFileSync(join(legacy, "alive"), "1712847600000");
      const gDir = generationDir(id);
      mkdirSync(gDir, { recursive: true });
      writeFileSync(join(gDir, "alive"), "1900000000000");

      expect(resolveOwnerTelemetry(sessionDir)).toEqual({ kind: "generation", dir: gDir, id });
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "alive", at: 1900000000000 });
    });

    it("a generation whose directory has no heartbeat is ABSENT, never a legacy fallback", () => {
      const id = newHeartbeatGenerationId();
      writeState({ heartbeatGeneration: id });
      const legacy = telemetryDirPath(sessionDir);
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "alive"), "1712847600000");

      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "absent" });
    });

    it("a MALFORMED generation is unusable, never absent and never legacy", () => {
      writeState({ heartbeatGeneration: "not a generation id" });
      const legacy = telemetryDirPath(sessionDir);
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "alive"), "1712847600000");

      const got = readOwnerHeartbeat(sessionDir);
      expect(got.kind).toBe("unusable");
      expect(got.kind === "unusable" && got.reason).toBe("malformed-generation-id");
    });

    it("a NON-STRING generation reaches the resolver unnarrowed and is unusable", () => {
      // Narrowing to `string` first would turn this into apparent absence and a
      // silent legacy fallback -- the resolver's contract is that anything not a
      // valid id is a refusal.
      writeState({ heartbeatGeneration: 12345 });
      expect(readOwnerHeartbeat(sessionDir)).toEqual({
        kind: "unusable",
        reason: "malformed-generation-id",
      });
    });

    it("an EMPTY-STRING generation is damage, not absence", () => {
      writeState({ heartbeatGeneration: "" });
      expect(readOwnerHeartbeat(sessionDir).kind).toBe("unusable");
    });

    it("unreadable session state is unusable, not absent", () => {
      expect(readOwnerHeartbeat(sessionDir)).toEqual({
        kind: "unusable",
        reason: "session-state-unreadable",
      });
    });

    it("invalid-JSON session state is unusable, not absent", () => {
      writeFileSync(join(sessionDir, "state.json"), "{ not json");
      expect(readOwnerHeartbeat(sessionDir)).toEqual({
        kind: "unusable",
        reason: "session-state-unparsable",
      });
    });

    it("session state that is not an object is unusable", () => {
      writeFileSync(join(sessionDir, "state.json"), "[1,2,3]");
      expect(readOwnerHeartbeat(sessionDir)).toEqual({
        kind: "unusable",
        reason: "session-state-unparsable",
      });
    });
  });

  // -------------------------------------------------------------------------
  // The strict reader: the three ways the system SAYS nobody is there
  // -------------------------------------------------------------------------

  describe("absent, and only these three", () => {
    beforeEach(() => writeState());

    it("no alive file at all (ENOENT)", () => {
      mkdirSync(telemetryDirPath(sessionDir), { recursive: true });
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "absent" });
    });

    it("no telemetry directory at all", () => {
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "absent" });
    });

    it("a canonical shutdown marker, even with a live-looking alive value", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");
      writeFileSync(join(tDir, "shutdown"), "1");
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "absent" });
    });

    it("a canonical alive value of 0", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "0");
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "absent" });
    });
  });

  describe("unusable, never absent", () => {
    beforeEach(() => writeState());

    it.skipIf(!canSymlink)("a shutdown marker that is a SYMLINK to a regular file is not a shutdown", () => {
      // Checked with `lstat`, so the link is rejected rather than followed.
      // Deliberately stricter than `readDeathMarker`, and stricter in the safe
      // direction: this answers "I cannot tell", which makes consumers stand
      // down, where following the link would answer "nobody is there".
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "real-marker"), "1");
      symlinkSync(join(tDir, "real-marker"), join(tDir, "shutdown"));
      writeFileSync(join(tDir, "alive"), "1712847600000");

      const got = readOwnerHeartbeat(sessionDir);
      expect(got.kind).toBe("unusable");
      expect(got.kind === "unusable" && got.reason).toBe("shutdown-marker-not-a-regular-file");
    });

    it.skipIf(!canSymlink)("a BROKEN shutdown symlink is damage too, not a missing marker", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      symlinkSync(join(tDir, "nothing-here"), join(tDir, "shutdown"));
      writeFileSync(join(tDir, "alive"), "1712847600000");

      // `lstat` sees the link itself, so a dangling target cannot read as ENOENT
      // and fall through to the alive file as though no marker existed.
      const got = readOwnerHeartbeat(sessionDir);
      expect(got.kind).toBe("unusable");
      expect(got.kind === "unusable" && got.reason).toBe("shutdown-marker-not-a-regular-file");
    });

    it("a shutdown marker of the wrong SHAPE is damage, not a shutdown", () => {
      // `absent` is what lets the waker spawn, so reading a directory left at
      // this path as "the session said it shut down" is fail-open in the one
      // direction that produces a second driver.
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(join(tDir, "shutdown"), { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");

      const got = readOwnerHeartbeat(sessionDir);
      expect(got.kind).toBe("unusable");
      expect(got.kind === "unusable" && got.reason).toBe("shutdown-marker-not-a-regular-file");
    });

    it.skipIf(!canDenyRead)("the alive file cannot be read (EACCES)", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");
      chmodSync(join(tDir, "alive"), 0o000);

      const got = readOwnerHeartbeat(sessionDir);
      try {
        expect(got.kind).toBe("unusable");
        expect(got.kind === "unusable" && got.reason).toBe("alive-unreadable");
      } finally {
        chmodSync(join(tDir, "alive"), 0o644);
      }
    });

    it.skipIf(!canDenyRead)("the shutdown probe fails for a reason other than ENOENT", () => {
      // `existsSync` returns false on EACCES as readily as on ENOENT, which is
      // exactly how a permissions fault used to read as "nobody said they left".
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");
      chmodSync(tDir, 0o000);

      const got = readOwnerHeartbeat(sessionDir);
      try {
        expect(got.kind).toBe("unusable");
        expect(got.kind === "unusable" && got.reason).toBe("shutdown-probe-unreadable");
      } finally {
        chmodSync(tDir, 0o755);
      }
    });

    it.skipIf(!canSymlink)("a symlink fault on the alive path (ELOOP) is unusable, not absence", () => {
      // `statSync` succeeds on a chmod-000 FILE -- only the read fails -- so a
      // permissions case never reaches the stat's own fault arm. A symlink loop
      // does, and it is the case that arm exists for.
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      symlinkSync(join(tDir, "alive"), join(tDir, "alive"));

      const got = readOwnerHeartbeat(sessionDir);
      expect(got.kind).toBe("unusable");
      expect(got.kind === "unusable" && got.reason).toBe("alive-unreadable");
    });

    it("the alive path is not a regular file", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(join(tDir, "alive"), { recursive: true });
      const got = readOwnerHeartbeat(sessionDir);
      expect(got.kind).toBe("unusable");
      expect(got.kind === "unusable" && got.reason).toBe("alive-not-a-regular-file");
    });

    it("the alive content does not parse as a number", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "not-a-timestamp");
      expect(readOwnerHeartbeat(sessionDir)).toMatchObject({
        kind: "unusable",
        reason: "alive-unparsable",
      });
    });

    it("the alive content is not finite", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "Infinity");
      expect(readOwnerHeartbeat(sessionDir)).toMatchObject({
        kind: "unusable",
        reason: "alive-unparsable",
      });
    });

    it("the alive content is negative (0 is canonical, below it is damage)", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "-1");
      expect(readOwnerHeartbeat(sessionDir)).toMatchObject({
        kind: "unusable",
        reason: "alive-unparsable",
      });
    });

    it("the alive file is empty (a truncated write is damage, not departure)", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "   ");
      expect(readOwnerHeartbeat(sessionDir)).toMatchObject({
        kind: "unusable",
        reason: "alive-unparsable",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  describe("writeShutdownMarker", () => {
    it("with no generation writes the legacy directory only, exactly as before", () => {
      writeState();
      const result = writeShutdownMarker(sessionDir);
      const legacy = telemetryDirPath(sessionDir);

      expect(result.attempted).toEqual([{ dir: legacy, ok: true, error: null }]);
      expect(readFileSync(join(legacy, "shutdown"), "utf-8")).toBe("1");
      expect(readFileSync(join(legacy, "alive"), "utf-8")).toBe("0");
    });

    it("with a generation writes BOTH directories, so an ENDED session stops reading alive", () => {
      const id = newHeartbeatGenerationId();
      writeState({ heartbeatGeneration: id });
      const gDir = generationDir(id);
      mkdirSync(gDir, { recursive: true });
      writeFileSync(join(gDir, "alive"), "1900000000000");
      expect(readOwnerHeartbeat(sessionDir).kind).toBe("alive");

      const result = writeShutdownMarker(sessionDir);
      const legacy = telemetryDirPath(sessionDir);

      expect(result.attempted.map((a) => a.dir).sort()).toEqual([gDir, legacy].sort());
      expect(result.attempted.every((a) => a.ok)).toBe(true);
      expect(existsSync(join(gDir, "shutdown"))).toBe(true);
      expect(existsSync(join(legacy, "shutdown"))).toBe(true);
      expect(readOwnerHeartbeat(sessionDir)).toEqual({ kind: "absent" });
      // The legacy accessor must ALSO stop reporting alive, for the callers
      // that genuinely mean the legacy directory.
      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });

    it("an unusable generation still writes legacy, and says which directory it could not resolve", () => {
      writeState({ heartbeatGeneration: "bogus" });
      const result = writeShutdownMarker(sessionDir);
      const legacy = telemetryDirPath(sessionDir);

      expect(result.attempted).toEqual([{ dir: legacy, ok: true, error: null }]);
      expect(result.unresolved).toBe("malformed-generation-id");
      expect(existsSync(join(legacy, "shutdown"))).toBe(true);
    });

    it.skipIf(!canDenyRead)("one directory failing does not suppress the other", () => {
      const id = newHeartbeatGenerationId();
      writeState({ heartbeatGeneration: id });
      const gDir = generationDir(id);
      mkdirSync(gDir, { recursive: true });
      const legacy = telemetryDirPath(sessionDir);
      // Deny writes to the generation directory only.
      chmodSync(gDir, 0o500);

      let result;
      try {
        result = writeShutdownMarker(sessionDir);
      } finally {
        chmodSync(gDir, 0o755);
      }

      const byDir = new Map(result.attempted.map((a) => [a.dir, a]));
      expect(byDir.get(gDir)?.ok).toBe(false);
      expect(byDir.get(gDir)?.error).toBeTruthy();
      expect(byDir.get(legacy)?.ok).toBe(true);
      expect(existsSync(join(legacy, "shutdown"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Establishment
  // -------------------------------------------------------------------------

  describe("spawnAliveSidecarFor", () => {
    let spawnedPid: number | null = null;

    afterEach(() => {
      if (spawnedPid) {
        try { killSidecar(spawnedPid); } catch { /* already gone */ }
        try { process.kill(spawnedPid, "SIGKILL"); } catch { /* already gone */ }
        spawnedPid = null;
      }
    });

    it("with no generation spawns into the legacy directory (byte-identical to today)", () => {
      const got = spawnAliveSidecarFor(sessionDir, undefined);
      expect(got.kind).toBe("spawned");
      if (got.kind === "spawned") {
        expect(got.dir).toBe(telemetryDirPath(sessionDir));
        spawnedPid = got.pid;
      }
    });

    it("with a generation spawns into THAT directory", () => {
      const id = newHeartbeatGenerationId();
      mkdirSync(generationDir(id), { recursive: true });
      const got = spawnAliveSidecarFor(sessionDir, id);
      expect(got.kind).toBe("spawned");
      if (got.kind === "spawned") {
        expect(got.dir).toBe(generationDir(id));
        spawnedPid = got.pid;
      }
    });

    it("with an unusable generation spawns NOTHING rather than falling back to legacy", () => {
      const got = spawnAliveSidecarFor(sessionDir, "bogus");
      expect(got).toEqual({ kind: "unusable", reason: "malformed-generation-id" });
      expect(existsSync(join(telemetryDirPath(sessionDir), "sidecar.pid"))).toBe(false);
    });
  });
  // -------------------------------------------------------------------------
  // The other consumers: generation-aware, and `unusable` is an explicit unknown
  // -------------------------------------------------------------------------

  describe("consumers", () => {
    it("collectProbes reads the GENERATION heartbeat, not the displaced owner's", () => {
      const id = newHeartbeatGenerationId();
      writeState({ heartbeatGeneration: id });
      const legacy = telemetryDirPath(sessionDir);
      mkdirSync(legacy, { recursive: true });
      // The displaced owner's heartbeat is FRESH; the current owner's is stale.
      // Reading legacy would report a healthy session that nobody is driving.
      writeFileSync(join(legacy, "alive"), String(Date.now()));
      const gDir = generationDir(id);
      mkdirSync(gDir, { recursive: true });
      writeFileSync(join(gDir, "alive"), String(Date.now() - 10 * 60_000));

      expect(collectProbes(sessionDir).alive).toBe(false);
    });

    it("collectProbes uses the CALLER's snapshot generation, not a second read of state.json", () => {
      // A takeover landing between a caller's session lookup and its probe pass
      // would otherwise leave two halves of one payload describing two
      // different owners.
      const id = newHeartbeatGenerationId();
      // On disk the session has ALREADY moved to a new generation.
      writeState({ heartbeatGeneration: newHeartbeatGenerationId() });
      const gDir = generationDir(id);
      mkdirSync(gDir, { recursive: true });
      writeFileSync(join(gDir, "alive"), String(Date.now()));

      expect(collectProbes(sessionDir, undefined, { heartbeatGeneration: id })).toMatchObject({ alive: true });
    });

    it("collectProbes reports an unreadable heartbeat as UNKNOWN, never as a stale one", () => {
      writeState({ heartbeatGeneration: "bogus" });
      mkdirSync(telemetryDirPath(sessionDir), { recursive: true });
      writeFileSync(join(telemetryDirPath(sessionDir), "alive"), String(Date.now()));

      expect(collectProbes(sessionDir).alive).toBeNull();
    });

    it("the status payload says alive=null when the heartbeat cannot be read", () => {
      writeState({ heartbeatGeneration: "bogus" });
      const root = join(tmpDir, "proj");
      mkdirSync(join(root, ".story"), { recursive: true });

      // The generation travels on the state the writer is ALREADY holding --
      // that copy is the state the decision is about, so it is preferred over
      // re-reading the file.
      refreshStatusForSession(root, sessionDir, {
        sessionId: "s-1",
        state: "IMPLEMENT",
        status: "active",
        heartbeatGeneration: "bogus",
      } as any, "guide");

      const payload = JSON.parse(readFileSync(join(root, ".story", "status.json"), "utf-8"));
      // Not `false`. False is a claim that nobody is there; this is a refusal
      // to claim anything.
      expect(payload.session?.alive ?? payload.alive).toBeNull();
    });

    it("the status payload says alive=false when the heartbeat is positively absent", () => {
      writeState();
      mkdirSync(telemetryDirPath(sessionDir), { recursive: true });
      const root = join(tmpDir, "proj2");
      mkdirSync(join(root, ".story"), { recursive: true });

      refreshStatusForSession(root, sessionDir, {
        sessionId: "s-1",
        state: "IMPLEMENT",
        status: "active",
      } as any, "guide");

      const payload = JSON.parse(readFileSync(join(root, ".story", "status.json"), "utf-8"));
      expect(payload.session?.alive ?? payload.alive).toBe(false);
    });
  });
});
