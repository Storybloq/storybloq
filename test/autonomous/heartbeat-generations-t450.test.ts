/**
 * T-450 step 3: generation-scoped heartbeat telemetry.
 *
 * WHY GENERATIONS EXIST. Two failures share one cause, that telemetry is a
 * single directory every owner writes to in turn.
 *
 *  - A failed `spawnAliveSidecar` does NOT leave the session byte-identical:
 *    before returning null it can create and chmod telemetry, kill a prior
 *    sidecar, unlink the shutdown marker, spawn a child and rewrite
 *    `sidecar.pid`.
 *  - Worse in the other direction, a SUCCESSFUL spawn followed by a failed
 *    commit leaves a heartbeat produced by the RECOVERING caller attached to
 *    the still-OLD owner, which suppresses recovery of that session
 *    indefinitely.
 *
 * A recovery therefore stages its heartbeat in a generation-specific directory
 * and publishes the generation id only in the same atomic postimage as
 * `ownerTask`. A staged generation nothing published is invisible to every
 * reader, and a marker written by an older generation is not consulted at all.
 *
 * THE ID IS A PATH SELECTOR, so it is treated as one. Persisting it makes
 * session state choose a DIRECTORY, and cleanup for that directory kills
 * processes and removes it. `.story/` is corruption-resistant rather than
 * forgery-resistant, but destructive behaviour keyed off a persisted string
 * needs a stricter rule than "parse it": the id is generated internally and is
 * opaque, it resolves only beneath the session's telemetry root, and cleanup
 * never runs against a path derived from a persisted value.
 *
 * Step 3 has NO CALLER. Nothing writes a generation yet, so every session on
 * disk today takes the legacy arm and behaves exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  newHeartbeatGenerationId,
  resolveTelemetryLocation,
  stageHeartbeatGeneration,
  discardStagedGeneration,
  readOwnerLiveness,
  evidenceFingerprint,
  telemetryDirPath,
  OWNER_STALE_MS,
  __testing,
  type OwnableLivenessState,
  type StagedHeartbeatGeneration,
} from "../../src/autonomous/liveness.js";
import * as livenessModule from "../../src/autonomous/liveness.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";

const NOW = Date.parse("2027-03-01T12:00:00.000Z");
const STALE = new Date(NOW - (OWNER_STALE_MS + 60_000)).toISOString();
const OWNER: OwnerTask = { client: "claude", id: "owner-task-aaa", boundAt: STALE };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-gen-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Whether this platform will create symlinks at all, probed once and up front.
 *
 * Checked BEFORE a test mutates anything. Swallowing a symlink failure inside a
 * swap callback that has already deleted the validated path would leave the
 * test passing because the path was merely missing, not because an escaping
 * symlink was refused, which is the property those tests exist to prove.
 */
const SYMLINKS_AVAILABLE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "t450-symlink-probe-"));
  try {
    fs.symlinkSync(probe, join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(probe, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})();

/** `dev:ino` of a directory, in the same form the staging handle records. */
function identityOf(dir: string): string {
  const stat = fs.lstatSync(dir, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function deadPid(): number {
  for (let candidate = 900_000; candidate < 1_000_000; candidate++) {
    try { process.kill(candidate, 0); } catch (e: any) {
      if (e?.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead pid for the fixture");
}

/** The observations that reach `gone-candidate`, minus the telemetry half. */
function candidateState(overrides: Partial<OwnableLivenessState> = {}): OwnableLivenessState {
  return {
    lastGuideCall: STALE,
    mcpServerPid: deadPid(),
    mcpGuideCallAt: STALE,
    lease: null,
    ownerTask: OWNER,
    ...overrides,
  };
}

/** The telemetry half: a corroborating shutdown marker and a sidecar pid file. */
function writeMarker(tDir: string, pid: number): void {
  fs.mkdirSync(tDir, { recursive: true });
  fs.writeFileSync(join(tDir, "shutdown"), STALE);
  fs.utimesSync(join(tDir, "shutdown"), new Date(NOW - 60_000), new Date(NOW - 60_000));
  fs.writeFileSync(join(tDir, "sidecar.pid"), String(pid));
}

const NO_SERVERS = () => ({ kind: "observed" as const, servers: [] });

/**
 * The spawn is a MODULE-PRIVATE seam, not a public option, because cleanup
 * stops the child through the capability the spawn returns: a caller able to
 * supply that spawn could hand staging a process it never created and have it
 * terminated on failure. Tests reach it through `__testing`.
 *
 * A fixture returns either a bare pid, whose terminate is RECORDED rather than
 * signalled, since several fixtures use this process's own pid and signalling
 * it would take the test runner down, or an explicit capability when the test
 * is about termination actually happening.
 */
const terminated: number[] = [];

type FakeSpawn = (dir: string, intervalMs: number) => number | { pid: number; terminate: () => void } | null;

function stage(
  sessionDir: string,
  options: { readinessTimeoutMs?: number; pollMs?: number; intervalMs?: number; spawn?: FakeSpawn } = {},
) {
  const { spawn: fake, ...rest } = options;
  if (fake) {
    __testing.stagingHooks.spawn = (dir, intervalMs) => {
      const result = fake(dir, intervalMs);
      if (result === null) return null;
      return typeof result === "number"
        ? { pid: result, terminate: () => { terminated.push(result); } }
        : result;
    };
  }
  try {
    return stageHeartbeatGeneration(sessionDir, rest);
  } finally {
    __testing.stagingHooks.spawn = null;
  }
}

/**
 * A real child that INSTALLS a SIGTERM handler and ignores it, for the tests
 * about the grace window. Cleanup goes through the retained ChildProcess rather
 * than a number read off a handle, and stops once exit has been observed. That
 * is narrower than "never signals the number": Node's `kill()` does signal the
 * stored pid, and ISS-930 records the one window where that matters.
 */
function stubbornChild() {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.on("exit", () => { exited = true; resolve(); }));
  return {
    child,
    exit,
    dispose: async () => {
      if (exited) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await exit;
    },
  };
}

/** A capability backed by a real child, for the tests that are about stopping it. */
function realChild() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.on("exit", () => { exited = true; resolve(); }));
  return {
    pid: child.pid!,
    /** The retained object, for tests whose own capability must inspect it. */
    process: child,
    // Guarded, so the helper matches what its own comment claims: it does not
    // signal after exit has been observed.
    terminate: () => {
      if (exited) return;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    },
    hasExited: () => exited,
    exit,
    // Cleanup goes through the retained ChildProcess and stops once exit has
    // been OBSERVED. Signalling the stored number after that is the very hazard
    // these tests exist to police, and a test harness gets no exemption. The
    // exit is awaited rather than assumed, so a child cannot outlive the test
    // that spawned it even when an assertion threw on the way here.
    dispose: async () => {
      if (exited) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await exit;
    },
  };
}

function verdictFor(state: OwnableLivenessState) {
  return readOwnerLiveness(root, () => state, NOW, OWNER_STALE_MS, NO_SERVERS);
}

describe("T-450: the generation id is opaque and internally generated", () => {
  it("is a fixed-length token from the canonical alphabet", () => {
    // Opaque on purpose. No caller-supplied value ever becomes one, and the
    // alphabet excludes the characters that make ids ambiguous when read aloud
    // or copied out of a log.
    for (let i = 0; i < 32; i++) {
      expect(newHeartbeatGenerationId()).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) seen.add(newHeartbeatGenerationId());
    expect(seen.size).toBe(256);
  });
});

describe("T-450: a generation id resolves only beneath the session telemetry root", () => {
  it("takes the legacy directory when no generation is recorded", () => {
    // The compatibility arm, and the reason step 3 has no caller: every session
    // on disk today has no generation and must behave exactly as before.
    // ONLY a genuinely absent value qualifies; see the malformed cases for why
    // the empty string is not one of them.
    for (const value of [undefined, null]) {
      const location = resolveTelemetryLocation(root, value);
      expect(location.kind).toBe("legacy");
      expect(location.kind === "legacy" && location.dir).toBe(telemetryDirPath(root));
    }
  });

  it("resolves a well-formed id under the telemetry root", () => {
    const id = newHeartbeatGenerationId();
    const location = resolveTelemetryLocation(root, id);
    expect(location.kind).toBe("generation");
    expect(location.kind === "generation" && location.dir)
      .toBe(join(telemetryDirPath(root), "generations", id));
  });

  it("refuses a value that is not one of our ids", () => {
    // Every one of these would otherwise be a path, and one of them would be a
    // path somewhere else entirely. A value failing the pattern is unusable
    // evidence, never a directory to read or delete.
    const bad: unknown[] = [
      // Present but empty. No session written before this feature carries the
      // field at all, so this is damage, and reading it as "no generation"
      // would point a generation-bearing session at the PREVIOUS owner's
      // telemetry, which is the confusion generations exist to end.
      "",
      // Not even a string. It arrives from JSON, so all of these are reachable.
      {},
      42,
      true,
      ["abcdefghjkmnpqrs"],
      "../../../etc",
      "abc/def",
      "abc\\def",
      ".",
      "..",
      "a".repeat(15),
      "a".repeat(17),
      "ABCDEFGHJKMNPQRS",   // uppercase is not our alphabet
      "iiiiiiiiiiiiiiii",   // excluded letters
      "0123456789abcde ",
      "/absolute/path00",
      // Contains a perfectly valid 16-character run, so an UNANCHORED pattern
      // would accept it and hand back a traversal.
      "aaaaaaaaaaaaaaaa/../../etc",
    ];
    for (const value of bad) {
      const location = resolveTelemetryLocation(root, value);
      expect(location.kind, JSON.stringify(value)).toBe("unusable");
      expect(location.kind === "unusable" && location.reason).toBe("malformed-generation-id");
    }
  });

  it("refuses a well-formed id whose directory is a symlink out of the tree", () => {
    // The check that cannot be done lexically. The id is impeccable; the
    // DIRECTORY it names is a link, and following it would read evidence from
    // outside the session, or delete something outside the session.
    const id = newHeartbeatGenerationId();
    const generations = join(telemetryDirPath(root), "generations");
    fs.mkdirSync(generations, { recursive: true });
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-elsewhere-"));
    try {
      fs.symlinkSync(outside, join(generations, id));
      const location = resolveTelemetryLocation(root, id);
      expect(location.kind).toBe("unusable");
      expect(location.kind === "unusable" && location.reason).toBe("generation-escapes-telemetry");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses when the generations DIRECTORY is a symlink and the leaf does not exist yet", () => {
    // The leaf-only check misses this. A generation that has not been created
    // has no real path, so checking only the leaf accepts the id, and staging
    // then creates the directory at the far end of the ancestor link, outside
    // the session entirely. The ancestor is therefore checked whether or not
    // the leaf exists.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-ancestor-"));
    try {
      fs.mkdirSync(telemetryDirPath(root), { recursive: true });
      fs.symlinkSync(outside, join(telemetryDirPath(root), "generations"));
      const id = newHeartbeatGenerationId();
      const location = resolveTelemetryLocation(root, id);
      expect(location.kind).toBe("unusable");
      expect(location.kind === "unusable" && location.reason).toBe("generation-escapes-telemetry");

      // And staging refuses rather than creating anything out there.
      expect(stageHeartbeatGeneration(root, { readinessTimeoutMs: 200 })).toBeNull();
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a component that exists but cannot be canonicalized", () => {
    // Fail-open by conflation, and the reason `realPath` distinguishes three
    // outcomes rather than two. A DANGLING symlink reports ENOENT from
    // `realpath` while the path very much exists, so reading that as "absent"
    // would skip the containment proof for a component that is already a link
    // pointing somewhere else. The same goes for EACCES and EIO: not knowing
    // where a path leads is not evidence that it leads nowhere.
    if (!SYMLINKS_AVAILABLE) return;
    fs.mkdirSync(telemetryDirPath(root), { recursive: true });
    fs.symlinkSync(join(tmpdir(), "t450-does-not-exist-", String(process.pid)), join(telemetryDirPath(root), "generations"));
    const location = resolveTelemetryLocation(root, newHeartbeatGenerationId());
    expect(location.kind).toBe("unusable");
    expect(location.kind === "unusable" && location.reason).toBe("generation-path-unresolvable");
    expect(stageHeartbeatGeneration(root, { readinessTimeoutMs: 200 })).toBeNull();
  });

  it("refuses when the confirming lstat is itself indeterminate", () => {
    // The last branch, and the only one a real filesystem will not produce on
    // demand: `realpath` says ENOENT, and the `lstat` that would tell us
    // whether the path is a dangling link fails for some other reason. Not
    // knowing is not the same as knowing it is absent, so it must refuse.
    const realLstat = __testing.fsApi.lstatSync;
    const realRealpath = __testing.fsApi.realpathSync;
    const generations = join(telemetryDirPath(root), "generations");
    __testing.fsApi.realpathSync = ((p: string) => {
      if (p === generations) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return realRealpath(p);
    }) as typeof fs.realpathSync;
    __testing.fsApi.lstatSync = ((p: string, opts?: any) => {
      if (p === generations) { const e: any = new Error("EIO"); e.code = "EIO"; throw e; }
      return realLstat(p, opts);
    }) as typeof fs.lstatSync;
    try {
      fs.mkdirSync(generations, { recursive: true });
      const location = resolveTelemetryLocation(root, newHeartbeatGenerationId());
      expect(location.kind).toBe("unusable");
      expect(location.kind === "unusable" && location.reason).toBe("generation-path-unresolvable");
    } finally {
      __testing.fsApi.lstatSync = realLstat;
      __testing.fsApi.realpathSync = realRealpath;
    }
  });

  it("refuses when a component cannot be read at all", () => {
    // The EACCES arm. Skipped where it cannot be arranged, since a process
    // running as root can read through any mode.
    if (process.getuid?.() === 0) return;
    const telemetry = telemetryDirPath(root);
    fs.mkdirSync(join(telemetry, "generations"), { recursive: true });
    fs.chmodSync(telemetry, 0o000);
    try {
      const location = resolveTelemetryLocation(root, newHeartbeatGenerationId());
      expect(location.kind).toBe("unusable");
      expect(location.kind === "unusable" && location.reason).toBe("generation-path-unresolvable");
    } finally {
      fs.chmodSync(telemetry, 0o700);
    }
  });

  it("accepts a generation inside a telemetry root that is ITSELF a symlink", () => {
    // Containment is about where the generation ends up, not about how the
    // session directory was reached. Rejecting this would break any project
    // living behind a symlinked path, which on macOS includes /tmp.
    if (!SYMLINKS_AVAILABLE) return;
    const real = mkdtempSync(join(tmpdir(), "t450-realtelemetry-"));
    try {
      const session = join(root, "session");
      fs.mkdirSync(session, { recursive: true });
      fs.symlinkSync(real, telemetryDirPath(session));
      const id = newHeartbeatGenerationId();
      fs.mkdirSync(join(real, "generations", id), { recursive: true });
      expect(resolveTelemetryLocation(session, id).kind).toBe("generation");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("T-450: reads consult only the generation named by session state", () => {
  it("does not see a staged generation nothing has published", () => {
    // The whole point. A recovery that staged a heartbeat and then failed to
    // commit leaves this directory behind; if a reader consulted it, that
    // failed recovery would suppress the session's recoverability for good.
    const state = candidateState();
    writeMarker(telemetryDirPath(root), state.mcpServerPid!);
    const staged = join(telemetryDirPath(root), "generations", newHeartbeatGenerationId());
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(join(staged, "alive"), String(NOW));

    // State names no generation, so the legacy marker still decides.
    expect(verdictFor(state).kind).toBe("gone-candidate");
  });

  it("does not consult the legacy directory once a generation is named", () => {
    // The other direction, and the one that matters after a takeover: an older
    // generation's marker must not corroborate for the owner that replaced it.
    const id = newHeartbeatGenerationId();
    const state = candidateState({ heartbeatGeneration: id });
    writeMarker(telemetryDirPath(root), state.mcpServerPid!);
    fs.mkdirSync(join(telemetryDirPath(root), "generations", id), { recursive: true });

    const verdict = verdictFor(state);
    expect(verdict.kind).not.toBe("gone-candidate");
    expect(verdict.signals.deathMarker.kind).toBe("unreadable");
  });

  it("reads the marker from the named generation", () => {
    const id = newHeartbeatGenerationId();
    const state = candidateState({ heartbeatGeneration: id });
    writeMarker(join(telemetryDirPath(root), "generations", id), state.mcpServerPid!);
    expect(verdictFor(state).kind).toBe("gone-candidate");
  });

  it("is undetermined, never evidence, when the named generation is unusable", () => {
    // Fail closed on a value that selects a path. An unusable id is not "no
    // marker", which would be an observation; it is a refusal to look.
    const state = candidateState({ heartbeatGeneration: "../../../etc" });
    writeMarker(telemetryDirPath(root), state.mcpServerPid!);
    const verdict = verdictFor(state);
    expect(verdict.kind).toBe("undetermined");
    expect(verdict.kind === "undetermined" && verdict.missing.join(" "))
      .toContain("malformed-generation-id");
    // The reason is carried through to the evidence rather than flattened to a
    // generic "could not read": malformed and escaping are different pictures,
    // and the fingerprint must not let one confirm against the other. Asserted
    // below rather than merely asserted here.
    expect(verdict.signals.deathMarker).toEqual({ kind: "unreadable", reason: "malformed-generation-id" });
    expect(verdict.signals.sidecarProbe).toEqual({ kind: "unknown", reason: "malformed-generation-id", pid: null });

    // Two unusable generations are not the same observation, so they must not
    // digest alike: a confirmation taken against one would otherwise validate
    // against the other.
    const escaping = {
      ...verdict.signals,
      deathMarker: { kind: "unreadable" as const, reason: "generation-escapes-telemetry" as const },
      sidecarProbe: { kind: "unknown" as const, reason: "generation-escapes-telemetry" as const, pid: null },
    };
    expect(evidenceFingerprint(escaping)).not.toBe(evidenceFingerprint(verdict.signals));
  });
});

describe("T-450: staging is not publication, and readiness is not a returned pid", () => {
  const stagedCleanup: StagedHeartbeatGeneration[] = [];
  afterEach(() => {
    for (const staged of stagedCleanup.splice(0)) {
      try { discardStagedGeneration(staged); } catch { /* best-effort */ }
    }
  });

  it("stages a real sidecar and acknowledges its first heartbeat", () => {
    const staged = stageHeartbeatGeneration(root, { intervalMs: 50, readinessTimeoutMs: 5_000 });
    expect(staged).not.toBeNull();
    stagedCleanup.push(staged!);
    expect(staged!.dir).toBe(join(telemetryDirPath(root), "generations", staged!.id));
    // Acknowledged means a heartbeat was actually observed, not that a pid was
    // returned. The file is the evidence.
    expect(Number(fs.readFileSync(join(staged!.dir, "alive"), "utf-8").trim())).toBeGreaterThan(0);
    expect(__testing.hasSidecarSignature(staged!.pid)).toBe(true);
  });

  it("refuses to publish when the staged child never starts", () => {
    // A returned pid is not a heartbeat. An earlier draft treated one as proof,
    // and a child that died before its first tick would leave the owner this
    // recovery just bound with a generation that can never heartbeat, so the
    // session could never itself be recovered through this feature. That
    // converts a live-owner false positive into a permanently unrecoverable
    // session, which is a different failure, not a safer one.
    //
    // "Unchanged" here means unchanged as EVIDENCE. An empty `generations`
    // container may be left behind, and deliberately is: removing it would mean
    // racing a concurrent staging for the privilege of deleting a directory
    // that no reader consults and that holds no marker, no alive file and no
    // pid. What must not change is anything `readOwnerLiveness` reads.
    const state = candidateState();
    writeMarker(telemetryDirPath(root), state.mcpServerPid!);
    const legacyBefore = fs.readdirSync(telemetryDirPath(root)).sort();
    const verdictBefore = verdictFor(state);

    expect(stage(root, { readinessTimeoutMs: 250, spawn: () => null })).toBeNull();

    expect(fs.readdirSync(telemetryDirPath(root)).sort())
      .toEqual([...legacyBefore, "generations"].sort());
    expect(fs.readdirSync(join(telemetryDirPath(root), "generations"))).toEqual([]);
    expect(verdictFor(state)).toEqual(verdictBefore);
  });

  it("refuses to publish when the staged child exits before its first heartbeat", () => {
    const dead = deadPid();
    const started = Date.now();
    const staged = stage(root, {
      readinessTimeoutMs: 10_000,
      spawn: () => dead,
    });
    expect(staged).toBeNull();
    // And it did not sit out the whole timeout. A definitively dead child is an
    // ANSWER, not something to keep waiting on: a recovery that blocks ten
    // seconds per attempt on a child that is already gone is a recovery nobody
    // waits for. "unknown" is different and must still be waited on, because it
    // means the probe could not answer, not that the process is dead.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.existsSync(join(telemetryDirPath(root), "generations"))).toBe(true);
    expect(fs.readdirSync(join(telemetryDirPath(root), "generations"))).toEqual([]);
  });

  it("refuses to publish when the child survives but writes no heartbeat", () => {
    // The second failure mode, and the one a liveness check alone would miss:
    // the process is right there, it just never ticked.
    const staged = stage(root, {
      readinessTimeoutMs: 300,
      pollMs: 25,
      spawn: () => process.pid,
    });
    expect(staged).toBeNull();
    expect(fs.readdirSync(join(telemetryDirPath(root), "generations"))).toEqual([]);
  });

  it("refuses when the staged directory is REPLACED between creation and use", () => {
    // The window the pre-check cannot cover. Resolution happens before the
    // directory exists, so the only thing standing between a swap and a sidecar
    // spawned outside the session is the re-check after creation.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-swapped-"));
    let spawned = 0;
    try {
      __testing.stagingHooks.at = (stage, dir) => {
        if (stage !== "created") return;
        rmSync(dir, { recursive: true, force: true });
        fs.symlinkSync(outside, dir);
      };
      const staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { spawned += 1; return process.pid; },
      });
      expect(staged).toBeNull();
      // Nothing was spawned into it, and nothing was written out there.
      expect(spawned).toBe(0);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      __testing.stagingHooks.at = () => {};
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("declines to reclaim a directory that is no longer the one it validated", () => {
    // The identity check on the cleanup path, pinned by an observable effect.
    // Bounded cleanup means "removed the wrong directory" is only visible when
    // that directory holds one of OUR names, so the replacement below is given
    // an `alive` file: without the check it is unlinked, with it nothing is.
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return deadPid(); },
      });
      expect(staged).not.toBeNull();
      const path = staged!.dir;
      // A DIFFERENT directory at the same path: same name, new inode.
      rmSync(path, { recursive: true, force: true });
      fs.mkdirSync(path, { recursive: true });
      fs.writeFileSync(join(path, "alive"), "someone else's");

      discardStagedGeneration(staged!);
      staged = null;
      // Untouched, because it is not the directory the handle was issued for.
      expect(fs.existsSync(join(path, "alive"))).toBe(true);
      expect(fs.readFileSync(join(path, "alive"), "utf-8")).toBe("someone else's");
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("declines to reclaim after a spawn that returned null in a swapped directory", () => {
    // The spawn-null arm. The swap happens INSIDE the spawn call, which is the
    // only window between the pre-spawn identity check and this cleanup.
    const victim = { path: "" };
    const staged = stage(root, {
      readinessTimeoutMs: 200,
      spawn: (dir) => {
        rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(join(dir, "alive"), "not ours");
        victim.path = join(dir, "alive");
        return null;
      },
    });
    expect(staged).toBeNull();
    expect(fs.existsSync(victim.path)).toBe(true);
  });

  it("declines to reclaim after a spawn that threw in a swapped directory", () => {
    // The spawn-throw arm, same window, same guarantee.
    const victim = { path: "" };
    const staged = stage(root, {
      readinessTimeoutMs: 200,
      spawn: (dir) => {
        rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(join(dir, "alive"), "not ours");
        victim.path = join(dir, "alive");
        throw new Error("spawn failed");
      },
    });
    expect(staged).toBeNull();
    expect(fs.existsSync(victim.path)).toBe(true);
  });

  it("declines to clean up when it cannot resolve its own containment root", () => {
    // Fail-closed on the ROOT, not just on the leaf. If the telemetry root
    // cannot be resolved, the code has no reference point to judge containment
    // against, and "cannot tell" must not be answered as "contained". Cleanup is
    // exactly the wrong place to guess, because the guess authorizes deletion.
    const realProbe = __testing.probeApi.probeArgvSignature;
    const realResolve = __testing.fsApi.realpathSync;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return deadPid(); },
      });
      expect(staged).not.toBeNull();
      const path = staged!.dir;
      const telemetryRoot = telemetryDirPath(root);
      // Only the ROOT becomes unresolvable; everything else answers normally.
      __testing.fsApi.realpathSync = ((p: string) => {
        if (p === telemetryRoot) { const e: any = new Error("EIO"); e.code = "EIO"; throw e; }
        return realResolve(p);
      }) as typeof realResolve;

      discardStagedGeneration(staged!);
      staged = null;
      // Nothing was reclaimed, because nothing could be proven.
      expect(fs.existsSync(join(path, "alive"))).toBe(true);
    } finally {
      __testing.fsApi.realpathSync = realResolve;
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("bounds what a swap in the final sliver can cost", () => {
    // The one window that cannot be closed from JavaScript: between the
    // containment proof and the unlink syscalls. A further path-based recheck
    // only moves it, and a deferred collector inherits it, because a collector
    // must also unlink by path. Only openat/unlinkat close it and Node has
    // neither. ISS-931 tracks that.
    //
    // So this test does not assert the window is gone. It asserts what it COSTS,
    // which is the property the design actually guarantees: only the names this
    // feature writes can be lost, and never a subtree. If someone later closes
    // the window properly, this test fails and should be rewritten upward.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-sliver-"));
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return deadPid(); },
      });
      expect(staged).not.toBeNull();
      const leaf = staged!.dir.slice(staged!.dir.lastIndexOf("/") + 1);
      fs.mkdirSync(join(outside, leaf, "nested"), { recursive: true });
      fs.writeFileSync(join(outside, leaf, "nested", "deep.txt"), "not ours");
      fs.writeFileSync(join(outside, leaf, "IRREPLACEABLE.txt"), "not ours");
      fs.writeFileSync(join(outside, leaf, "alive"), "theirs, same name");

      __testing.stagingHooks.at = (stageName, dir) => {
        if (stageName !== "before-unlink") return;
        const parent = join(dir, "..");
        rmSync(parent, { recursive: true, force: true });
        fs.symlinkSync(outside, parent);
      };
      discardStagedGeneration(staged!);
      staged = null;

      // THE BOUND HOLDS. The subtree is intact, the unrelated file is intact,
      // and the directory itself survives because it is not empty.
      expect(fs.existsSync(join(outside, leaf, "nested", "deep.txt"))).toBe(true);
      expect(fs.existsSync(join(outside, leaf, "IRREPLACEABLE.txt"))).toBe(true);
      expect(fs.existsSync(join(outside, leaf))).toBe(true);
      // THE COST, stated rather than hidden: a file sharing one of our names is
      // what a lost race takes. This assertion is the documented residual.
      expect(fs.existsSync(join(outside, leaf, "alive"))).toBe(false);
    } finally {
      __testing.stagingHooks.at = () => {};
      __testing.probeApi.probeArgvSignature = realProbe;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cannot destroy a subtree even when the swap lands between the check and the syscall", () => {
    // The window no path-based API can close: `removeIfStillOurs` verifies the
    // identity and then removes by path, and the parent can be replaced in
    // between. Node exposes no handle-relative removal that would make those one
    // operation. So the removal is built to be harmless when it loses the race
    // rather than to depend on winning it: it unlinks only the names this
    // feature writes, then removes the directory only if that left it empty.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-toctou-"));
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return deadPid(); },
      });
      expect(staged).not.toBeNull();
      const leaf = staged!.dir.slice(staged!.dir.lastIndexOf("/") + 1);
      // Somebody else's directory, at the path ours will resolve to. It is given
      // the very names cleanup is allowed to unlink, because a foreign directory
      // may legitimately use them and excluding them would make this test prove
      // only that already-ineligible names are safe.
      fs.mkdirSync(join(outside, leaf, "nested"), { recursive: true });
      fs.writeFileSync(join(outside, leaf, "IRREPLACEABLE.txt"), "not ours");
      fs.writeFileSync(join(outside, leaf, "nested", "deep.txt"), "also not ours");
      fs.writeFileSync(join(outside, leaf, "alive"), "theirs, same name");
      fs.writeFileSync(join(outside, leaf, "shutdown"), "theirs too");
      fs.writeFileSync(join(outside, leaf, "sidecar.pid"), "12345");
      fs.writeFileSync(join(outside, leaf, "sidecar.lock.tmp.9.9.abcd"), "theirs");

      __testing.stagingHooks.at = (stageName, dir) => {
        if (stageName !== "before-remove") return;
        const parent = join(dir, "..");
        rmSync(parent, { recursive: true, force: true });
        fs.symlinkSync(outside, parent);
      };
      discardStagedGeneration(staged!);
      staged = null;

      // EVERYTHING foreign is still there, including the files that share our
      // own names. The containment proof is re-run as late as it can be, so a
      // swap that is still in place at cleanup time is caught outright rather
      // than raced, and nothing is unlinked at all.
      for (const name of ["IRREPLACEABLE.txt", "alive", "shutdown", "sidecar.pid", "sidecar.lock.tmp.9.9.abcd"]) {
        expect(fs.existsSync(join(outside, leaf, name))).toBe(true);
      }
      expect(fs.existsSync(join(outside, leaf, "nested", "deep.txt"))).toBe(true);
    } finally {
      __testing.stagingHooks.at = () => {};
      __testing.probeApi.probeArgvSignature = realProbe;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves behind a directory holding anything it did not write", () => {
    // The other half of bounded cleanup, and the direction it fails in. An
    // unexpected member means this is not the directory we think it is, so the
    // removal LEAKS rather than guesses. Leaking is recoverable; deleting is not.
    // Driven through a real staging failure rather than by calling cleanup
    // directly, because a destructive helper is not something production code
    // should be able to import and point at an arbitrary path.
    let dir = "";
    const staged = stage(root, {
      readinessTimeoutMs: 200,
      spawn: (d) => {
        dir = d;
        fs.writeFileSync(join(d, "alive"), String(Date.now()));
        fs.writeFileSync(join(d, "somebody-elses-file"), "keep me");
        return null; // cleanup runs on this arm
      },
    });
    expect(staged).toBeNull();
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(join(dir, "somebody-elses-file"))).toBe(true);
    // Our own member was still reclaimed.
    expect(fs.existsSync(join(dir, "alive"))).toBe(false);
  });

  it("does not DELETE what it just proved is not ours", () => {
    // The escaped-after-create branch is the one cleanup site that must refuse
    // to clean up. It fires because containment FAILED, so at that point the
    // path is not provably inside the tree, and an identity read from that same
    // path can only be compared against itself. Removing on the strength of a
    // tautology would recursively delete whatever now sits there.
    //
    // The leaf is swapped by replacing its PARENT rather than the leaf: a
    // symlink AT the leaf is caught earlier by `lstat` (a link is not a
    // directory, so identity is null and there was never anything to remove).
    // Going through the parent makes `dir` resolve to a REAL foreign directory,
    // which is the case that can actually be destroyed.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-notours-"));
    try {
      __testing.stagingHooks.at = (stageName, dir) => {
        if (stageName !== "created") return;
        const parent = join(dir, "..");
        const leaf = dir.slice(dir.lastIndexOf("/") + 1);
        // Somebody else's data, already there, entirely outside the session.
        fs.mkdirSync(join(outside, leaf, "nested"), { recursive: true });
        fs.writeFileSync(join(outside, leaf, "IRREPLACEABLE.txt"), "not ours");
        rmSync(parent, { recursive: true, force: true });
        fs.symlinkSync(outside, parent);
      };
      let spawned = 0;
      const staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { spawned += 1; return process.pid; },
      });
      expect(staged).toBeNull();
      expect(spawned).toBe(0);
      // The foreign data is still there, untouched.
      const survivors = fs.readdirSync(outside);
      expect(survivors.length).toBe(1);
      expect(fs.existsSync(join(outside, survivors[0], "IRREPLACEABLE.txt"))).toBe(true);
      expect(fs.existsSync(join(outside, survivors[0], "nested"))).toBe(true);
    } finally {
      __testing.stagingHooks.at = () => {};
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to publish when the spawn THROWS, and leaves nothing staged", () => {
    // The real spawn can throw from lock setup or an unexpected filesystem
    // error. An escaping exception would break the null-on-failure contract and
    // leave behind a staged directory for a generation nobody will ever publish.
    const keep = join(telemetryDirPath(root), "generations", newHeartbeatGenerationId());
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(join(keep, "alive"), String(NOW));

    let staged: StagedHeartbeatGeneration | null = null;
    expect(() => {
      staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { throw new Error("spawn failed"); },
      });
    }).not.toThrow();
    expect(staged).toBeNull();
    // Its own leaf is gone, and the earlier generation is untouched.
    expect(fs.readdirSync(join(telemetryDirPath(root), "generations"))).toEqual([keep.split("/").pop()]);
  });

  it("refuses when the validated PARENT is swapped before the leaf is created", () => {
    // A distinct window from the one below: the parent passes `lstat`, and is
    // then replaced before the leaf is created inside it.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-parentswap-"));
    try {
      __testing.stagingHooks.at = (stage, path) => {
        if (stage !== "before-create") return;
        const parent = join(path, "..");
        rmSync(parent, { recursive: true, force: true });
        fs.symlinkSync(outside, parent);
      };
      let spawned = 0;
      const staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { spawned += 1; return process.pid; },
      });
      expect(staged).toBeNull();
      expect(spawned).toBe(0);
      // It refuses, and it also refuses to REACH OUT THERE to tidy up. The leaf
      // we created before noticing is left behind, because removing it would
      // mean deleting through a path we have just proven we cannot vouch for,
      // and that is the trade this feature makes deliberately: leaking an empty
      // directory somewhere unexpected is recoverable, deleting through an
      // unstable path is not. Nothing else out there is touched.
      expect(fs.readdirSync(outside).length).toBe(1);
      expect(fs.readdirSync(join(outside, fs.readdirSync(outside)[0]))).toEqual([]);
    } finally {
      __testing.stagingHooks.at = () => {};
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a parent swapped between its containment check and its creation", () => {
    // The window the pre-resolution cannot cover, and the reason the `lstat` is
    // not redundant with the re-resolution that follows it. Without the lstat
    // the leaf is created at the far end of the link FIRST and removed only
    // once the later check notices, so the difference between the two is
    // whether anything is ever created outside the session at all.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-preparent-"));
    let reachedCreate = false;
    try {
      __testing.stagingHooks.at = (stage, path) => {
        if (stage === "before-create") { reachedCreate = true; return; }
        if (stage !== "before-parent") return;
        rmSync(path, { recursive: true, force: true });
        // The hook fires before the telemetry root itself is guaranteed to
        // exist, so make it before putting the link in the way.
        fs.mkdirSync(join(path, ".."), { recursive: true });
        // No catch. Capability was established up front, so a failure here is a
        // failure to create the condition the test claims to be testing, and
        // swallowing it would leave the path merely MISSING: staging would
        // refuse for that reason instead, and the assertion below would pass
        // without an escaping symlink ever having existed.
        fs.symlinkSync(outside, path);
      };
      let spawned = 0;
      const staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { spawned += 1; return process.pid; },
      });
      expect(staged).toBeNull();
      expect(spawned).toBe(0);
      // Nothing was created out there and then tidied up. Nothing was created.
      expect(reachedCreate).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      __testing.stagingHooks.at = () => {};
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a leaf that already exists, rather than adopting it", () => {
    // Non-recursive creation on purpose. A recursive mkdir treats an existing
    // path as success, so it would silently adopt whatever is already sitting
    // there, including a directory another process is using or a link somebody
    // put in the way. EEXIST is the correct answer to "create this new thing".
    let spawned = 0;
    __testing.stagingHooks.at = (stage, path) => {
      if (stage !== "before-create") return;
      fs.mkdirSync(path, { recursive: true });
      fs.writeFileSync(join(path, "squatter"), "not yours");
    };
    try {
      const staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { spawned += 1; return process.pid; },
      });
      expect(staged).toBeNull();
      expect(spawned).toBe(0);
    } finally {
      __testing.stagingHooks.at = () => {};
    }
  });

  it("refuses when the validated LEAF is swapped after its check and before the spawn", () => {
    // The window the post-create resolution cannot see, because it has already
    // run by the time this happens. The identity bracket is what closes it: the
    // directory is remembered by `dev:ino`, so a replacement at the same path
    // is a different directory even though the path is unchanged.
    __testing.stagingHooks.at = (stage, path) => {
      if (stage !== "before-spawn") return;
      rmSync(path, { recursive: true, force: true });
      fs.mkdirSync(path, { recursive: true });
    };
    try {
      let spawned = 0;
      const staged = stage(root, {
        readinessTimeoutMs: 200,
        spawn: () => { spawned += 1; return process.pid; },
      });
      expect(staged).toBeNull();
      // Nothing is spawned into a directory we no longer recognise.
      expect(spawned).toBe(0);
    } finally {
      __testing.stagingHooks.at = () => {};
    }
  });

  it("refuses when the directory is swapped WHILE readiness is being acknowledged", () => {
    // The last bracket. The heartbeat that satisfies readiness has to have been
    // written in the directory that was validated, not in whatever now occupies
    // that path: a swap here would publish a generation whose evidence came
    // from somewhere else entirely.
    //
    // The signature probe is forced to "match" so that readiness genuinely
    // SUCCEEDS. Without that this test passes for the wrong reason, since the
    // test process carries no sidecar signature and readiness would refuse on
    // its own, leaving the identity check unexercised.
    const realProbe = __testing.probeApi.probeArgvSignature;
    __testing.probeApi.probeArgvSignature = () => "match";
    try {
      let replacement = "";
      const staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => {
          rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(join(dir, "alive"), String(Date.now()));
          // Whatever put this directory here owns it now.
          fs.writeFileSync(join(dir, "sentinel"), "belongs to the other operation");
          replacement = dir;
          return process.pid;
        },
      });
      expect(staged).toBeNull();
      // Refusing to publish must not turn into destroying somebody else's
      // telemetry. Cleanup removes the directory it validated, and this is no
      // longer that directory.
      expect(fs.existsSync(join(replacement, "sentinel"))).toBe(true);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("stops the staged child even when the path it lived at is no longer readable", async () => {
    // Cleanup is unconditional for the CHILD and conditional only for the
    // DIRECTORY. A path replaced by an escaping symlink makes resolution
    // unusable, and an implementation that decided whether to stop the child by
    // re-resolving that path would orphan a sidecar heartbeating into a
    // generation nobody will publish.
    if (!SYMLINKS_AVAILABLE) return;
    const outside = mkdtempSync(join(tmpdir(), "t450-orphan-"));
    fs.writeFileSync(join(outside, "sentinel"), "not ours to delete");
    const child = realChild();
    const realProbe = __testing.probeApi.probeArgvSignature;
    __testing.probeApi.probeArgvSignature = () => "match";
    try {
      const staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => {
          fs.writeFileSync(join(dir, "alive"), String(Date.now()));
          rmSync(dir, { recursive: true, force: true });
          fs.symlinkSync(outside, dir);
          return child;
        },
      });
      expect(staged).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.hasExited()).toBe(true);
      // ...and the thing at the far end of the link is untouched.
      expect(fs.existsSync(join(outside, "sentinel"))).toBe(true);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      await child.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not accept an unverifiable signature until the window has closed", () => {
    // "unknown" is a probe that could not answer, never a death, so it must not
    // end the wait early the way "absent" does. It is accepted only after the
    // whole window has passed with a heartbeat present and no definitive
    // absence, because requiring "match" outright would make staging fail
    // permanently wherever argv inspection is unavailable, and a feature that
    // cannot recover a session on that platform is not a safer feature.
    const realProbe = __testing.probeApi.probeArgvSignature;
    __testing.probeApi.probeArgvSignature = () => "unknown";
    try {
      const started = Date.now();
      const staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return process.pid; },
      });
      expect(staged).not.toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      discardStagedGeneration(staged!);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("does not accept a heartbeat that has since been REFUTED", () => {
    // The sticky-flag trap. `readAliveTimestampIn` returns null once a shutdown
    // marker appears, so a readiness loop that remembers an earlier tick would
    // accept a generation whose own telemetry now says it stopped. Readiness is
    // a claim about the current state, not about a state that once held.
    //
    // The marker is written from inside the PROBE seam, which the loop calls on
    // every poll. A timer cannot do it: the readiness wait is synchronous, so
    // the event loop never turns while it runs and a `setTimeout` callback
    // would only fire long after the window closed, leaving the heartbeat
    // visible throughout and the test green against a sticky implementation.
    const realProbe = __testing.probeApi.probeArgvSignature;
    let generationDir = "";
    // Counted separately from raw polls because only a poll that can SEE the
    // generation says anything about stickiness, and because a poll landing
    // before the spawn seam runs has no directory to write into: joining a
    // marker against "" resolves against the process cwd, which is this repo.
    let observedPolls = 0;
    __testing.probeApi.probeArgvSignature = () => {
      if (generationDir !== "") {
        observedPolls += 1;
        if (observedPolls === 2) fs.writeFileSync(join(generationDir, "shutdown"), "1");
      }
      return "unknown";
    };
    try {
      const staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => {
          generationDir = dir;
          fs.writeFileSync(join(dir, "alive"), String(Date.now()));
          return process.pid;
        },
      });
      // At least one poll saw a LIVE heartbeat before the marker refuted it, so
      // a sticky implementation would have had something to remember.
      expect(observedPolls).toBeGreaterThanOrEqual(2);
      expect(staged).toBeNull();
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("never accepts an unverifiable signature without a heartbeat", () => {
    const realProbe = __testing.probeApi.probeArgvSignature;
    __testing.probeApi.probeArgvSignature = () => "unknown";
    try {
      expect(stage(root, {
        readinessTimeoutMs: 300,
        pollMs: 25,
        spawn: () => process.pid,
      })).toBeNull();
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("does not delete a replacement when the spawn then fails", () => {
    // Cleanup on the spawn-failure arms is identity-aware for the same reason
    // the readiness arm is. The window is real: the directory can be replaced
    // after the pre-spawn identity check and before the spawn returns null or
    // throws, and an unconditional remove would then destroy the concurrent
    // operation's directory while tidying up after ours.
    for (const failure of ["null", "throw"] as const) {
      const session = join(root, `s-${failure}`);
      fs.mkdirSync(session, { recursive: true });
      let replacement = "";
      const staged = stage(session, {
        readinessTimeoutMs: 200,
        spawn: (dir) => {
          rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(join(dir, "sentinel"), "belongs to the other operation");
          replacement = dir;
          if (failure === "throw") throw new Error("spawn failed");
          return null;
        },
      });
      expect(staged, failure).toBeNull();
      expect(fs.existsSync(join(replacement, "sentinel")), failure).toBe(true);
    }
  });

  it("leaves an EARLIER generation untouched when a later staging fails", () => {
    // Cleanup is scoped to the generation that failed: a SIBLING generation in
    // the same directory is left alone, because the prior owner's telemetry is
    // the evidence its own recovery would depend on. Scoped, not absolute: the
    // final check-to-use window in ISS-931 can still cost bounded reserved-name
    // files in a directory that is not ours, which is a different claim from
    // the one this fixture exercises.
    const keep = join(telemetryDirPath(root), "generations", newHeartbeatGenerationId());
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(join(keep, "alive"), String(NOW));
    writeMarker(telemetryDirPath(root), deadPid());

    expect(stage(root, { readinessTimeoutMs: 200, spawn: () => null })).toBeNull();

    expect(fs.readFileSync(join(keep, "alive"), "utf-8")).toBe(String(NOW));
    expect(fs.existsSync(join(telemetryDirPath(root), "shutdown"))).toBe(true);
  });
});

describe("T-450: destructive cleanup is never driven by a persisted value", () => {
  it("refuses any object staging did not issue, however well-formed", () => {
    // Provenance is membership, not shape. This handle is malformed as well as
    // unissued; the test below is the harder case, where every field is exactly
    // right. Neither is accepted, and there is no path anywhere that reads a
    // generation id off disk and then removes the directory it names.
    const elsewhere = mkdtempSync(join(tmpdir(), "t450-victim-"));
    try {
      fs.writeFileSync(join(elsewhere, "precious"), "keep me");
      // A forgery by type as well as by fact: the handle is branded, so
      // building one takes a cast, which is the compiler saying what the
      // runtime also says.
      discardStagedGeneration({
        id: newHeartbeatGenerationId(),
        dir: elsewhere,
        sessionDir: root,
        pid: deadPid(),
        identity: "0:0",
      } as unknown as StagedHeartbeatGeneration);
      expect(fs.existsSync(join(elsewhere, "precious"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not kill the process named by a handle staging never returned", async () => {
    // Provenance, not shape, and the two layers do different jobs. Only the
    // TYPE is exported now, so ordinary callers cannot construct a
    // compile-time-valid handle at all. That stops honest mistakes, not casts:
    // a cast or plain JavaScript can still fabricate a lookalike with a valid
    // id, the exact path that id derives to, a matching directory identity and
    // any pid at all. Fields agreeing with one another prove only that the
    // caller could do the arithmetic, so the RUNTIME authority is having been
    // returned by staging, and nothing else.
    const id = newHeartbeatGenerationId();
    const dir = join(telemetryDirPath(root), "generations", id);
    fs.mkdirSync(dir, { recursive: true });
    const child = realChild();
    try {
      expect(child.pid).toBeTruthy();
      discardStagedGeneration({
        id,
        dir,                       // exactly where that id lives
        sessionDir: root,
        pid: child.pid,
        identity: identityOf(dir), // and exactly the directory that is there
      } as unknown as StagedHeartbeatGeneration);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.hasExited()).toBe(false);
      // Nor was the directory removed on the strength of a handle we never issued.
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      await child.dispose();
    }
  });

  it("stops the child through the retained capability, not through the handle's fields", async () => {
    // The reason cleanup holds a capability rather than a number. A pid is
    // reusable, so a delayed kill by number can land on somebody else's
    // process, and no probe fixes that: `unknown` cannot tell a recycled pid
    // from our own child, while requiring a positive match would orphan real
    // sidecars wherever argv inspection is unavailable. Going through the
    // capability the spawn returned makes the probe's answer irrelevant to
    // cleanup, which is why this test forces the least helpful one.
    //
    // Stated exactly, because it is easy to claim too much: this removes the
    // dependence on a PROBE, not the underlying use of a number. Node's
    // `ChildProcess.kill()` still signals the stored pid, and ISS-930 records
    // the one window where that matters. What is proven here is narrower and
    // still worth proving: cleanup acts through the retained capability rather
    // than through fields read off the handle it was given.
    const child = realChild();
    const realProbe = __testing.probeApi.probeArgvSignature;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      const staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return child; },
      });
      expect(staged).not.toBeNull();

      __testing.probeApi.probeArgvSignature = () => "absent";
      discardStagedGeneration(staged!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.hasExited()).toBe(true);
      expect(fs.existsSync(staged!.dir)).toBe(false);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      await child.dispose();
    }
  });

  it("does not signal anything when the child has already gone", async () => {
    // What discard actually guarantees: it acts through the capability staging
    // recorded, and this fixture's capability declines once the child's own
    // exit is reflected in its fields. Stated that way on purpose. It is NOT a
    // proof that the recycled-pid hazard is closed by construction, because
    // this exercises a fake capability rather than production `terminateChild`,
    // and because ISS-930 documents a window where a reaped sibling still
    // reports null exit fields.
    const child = realChild();
    let signals = 0;
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => {
          fs.writeFileSync(join(dir, "alive"), String(Date.now()));
          return {
            pid: child.pid,
            terminate: () => {
              signals += 1;
              if (child.process.exitCode !== null || child.process.signalCode !== null) return;
              try { child.process.kill("SIGTERM"); } catch { /* already gone */ }
            },
          };
        },
      });
      expect(staged).not.toBeNull();
      child.process.kill("SIGKILL");
      await child.exit;
      expect(child.hasExited()).toBe(true);

      discardStagedGeneration(staged!);
      // The capability was consulted and correctly declined to signal.
      expect(signals).toBe(1);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      await child.dispose();
    }
  });

  it("freezes the handle it issues", () => {
    // `readonly` is a compile-time fiction, so the runtime has to refuse the
    // assignment itself.
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return deadPid(); },
      });
      expect(staged).not.toBeNull();
      expect(Object.isFrozen(staged)).toBe(true);
      expect(() => { (staged as unknown as Record<string, unknown>).pid = 1; }).toThrow();
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      discardStagedGeneration(staged!);
    }
  });

  it("acts on the record it kept, not on the handle's fields", async () => {
    // The SECOND protection, and the freeze hides it: with the handle frozen,
    // reading `staged.dir` and reading the stored record are the same value on
    // every path, so nothing distinguishes them. The seam issues an unfrozen
    // handle so the mutation can actually take effect, which is the only way to
    // show that dropping the freeze in a later edit would not quietly reopen
    // this: one legitimate capability must not become a licence to stop any
    // process and delete any directory whose inode happens to match.
    const victim = mkdtempSync(join(tmpdir(), "t450-mutated-"));
    const child = realChild();
    const realProbe = __testing.probeApi.probeArgvSignature;
    __testing.probeApi.probeArgvSignature = () => "match";
    __testing.stagingHooks.freezeHandles = false;
    let terminations = 0;
    try {
      fs.writeFileSync(join(victim, "sentinel"), "not yours");
      const staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => {
          fs.writeFileSync(join(dir, "alive"), String(Date.now()));
          return { pid: deadPid(), terminate: () => { terminations += 1; } };
        },
      });
      expect(staged).not.toBeNull();
      expect(Object.isFrozen(staged)).toBe(false);
      const stagedDir = staged!.dir;

      // Point the handle at another process and another directory. These
      // assignments SUCCEED here.
      const mutable = staged as unknown as Record<string, unknown>;
      mutable.pid = child.pid;
      mutable.dir = victim;
      mutable.identity = identityOf(victim);

      discardStagedGeneration(staged!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The record's capability was used, not the pid now on the handle.
      expect(terminations).toBe(1);
      expect(child.hasExited()).toBe(false);
      // And the directory removed is the one that was staged.
      expect(fs.existsSync(join(victim, "sentinel"))).toBe(true);
      expect(fs.existsSync(stagedDir)).toBe(false);
    } finally {
      __testing.stagingHooks.freezeHandles = true;
      __testing.probeApi.probeArgvSignature = realProbe;
      await child.dispose();
      rmSync(victim, { recursive: true, force: true });
    }
  });

  it("cannot be copied, which is a compile error and not merely a refusal", () => {
    // The handle carries a private field, so a spread or clone is not this
    // type. Checked by the compiler on this file rather than only at runtime,
    // which is why the two lines below are written as type assertions.
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => { fs.writeFileSync(join(dir, "alive"), String(Date.now())); return deadPid(); },
      });
      expect(staged).not.toBeNull();
      const copy = { ...staged! };
      // @ts-expect-error a spread is not a capability
      discardStagedGeneration(copy);
      // @ts-expect-error nor is a structurally identical literal
      discardStagedGeneration({ id: staged!.id, dir: staged!.dir, sessionDir: root, pid: staged!.pid, identity: staged!.identity, issued: true });
      // ...and at runtime both are refused too, so the directory is still here.
      expect(fs.existsSync(staged!.dir)).toBe(true);

      // The other half of the claim: there is no way to MINT one either. Only
      // the type is exported, so the module has no value under this name, and
      // naming one is a compile error. If an issuer is ever exported again this
      // line stops erroring and the assertion below fails, which is the point.
      // @ts-expect-error the handle has no value side: staging is the only issuer
      const issuer = livenessModule.StagedHeartbeatGeneration;
      expect(issuer).toBeUndefined();
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      discardStagedGeneration(staged!);
    }
  });

  it("refuses a wait that is not actually bounded", () => {
    // Both non-finite values defeat the bound they are supposed to set, in
    // opposite ways. `Date.now() + NaN` is NaN and every comparison against NaN
    // is false, so a NaN timeout produces a loop with no reachable deadline. An
    // infinite poll parks the caller inside `Atomics.wait` and never returns.
    // Neither is clamped to something enormous; both fall back to the default,
    // because a caller passing NaN has not expressed a duration at all.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(__testing.durationOption(bad, 5_000, 0, 60_000)).toBe(5_000);
    }
    expect(__testing.durationOption(undefined, 5_000, 0, 60_000)).toBe(5_000);
    // A negative value IS coherent (ask for no wait) so it is clamped, not
    // refused, and the floor is what keeps a zero poll from becoming a spin.
    expect(__testing.durationOption(-1, 5_000, 0, 60_000)).toBe(0);
    expect(__testing.durationOption(-1, 25, 1, 1_000)).toBe(1);
    expect(__testing.durationOption(9_999_999, 5_000, 0, 60_000)).toBe(60_000);
    expect(__testing.durationOption(250, 5_000, 0, 60_000)).toBe(250);
  });

  it("never waits on a duration it did not normalize", () => {
    // The end-to-end wiring, on the path where readiness FAILS, which is the
    // only path that reaches the sleep at all.
    //
    // This is asserted through the sleep seam rather than by actually waiting,
    // because the regression it guards blocks synchronously: an unnormalized
    // poll parks inside `Atomics.wait`, which holds the event loop, so no test
    // timer could fire to report it and the whole suite would hang until an
    // outer job timeout with nothing naming the cause. Observing the value
    // turns that hang into an assertion, and the iteration cap turns a
    // never-reachable deadline into a fast failure instead of a spin.
    const realProbe = __testing.probeApi.probeArgvSignature;
    const realSleep = __testing.timeApi.sleepMs;
    const waits: number[] = [];
    try {
      __testing.probeApi.probeArgvSignature = () => "unknown";
      __testing.timeApi.sleepMs = (ms: number) => {
        // The dangerous value is RECORDED and never waited on: the seam always
        // sleeps a small safe amount instead, so even a full regression to
        // `Infinity` costs milliseconds rather than parking the process.
        waits.push(ms);
        if (waits.length > 200) throw new Error("readiness loop did not terminate");
        realSleep(5);
      };
      const staged = stage(root, {
        readinessTimeoutMs: 150,
        pollMs: Infinity,
        spawn: () => process.pid, // alive, but never writes a heartbeat
      });
      expect(staged).toBeNull();
      expect(waits.length).toBeGreaterThan(0);
      // Every value the loop actually waited on is finite and inside the ceiling.
      for (const ms of waits) {
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeLessThanOrEqual(1_000);
      }
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      __testing.timeApi.sleepMs = realSleep;
    }
  });

  it("reaches its deadline even when the caller's timeout was not a number", () => {
    // The other half of the same wiring. A NaN timeout produces a deadline no
    // comparison can ever satisfy, so the loop would run forever; normalized,
    // it falls back to the default and terminates. The seam does the waiting,
    // so this costs iterations rather than wall time, and the cap converts a
    // regression into a failure instead of an indefinite spin.
    const realProbe = __testing.probeApi.probeArgvSignature;
    const realSleep = __testing.timeApi.sleepMs;
    let now = Date.now();
    const realNow = Date.now;
    try {
      __testing.probeApi.probeArgvSignature = () => "unknown";
      // The clock advances only because the loop asked to wait, which is what
      // makes a normalized deadline reachable in a handful of iterations.
      __testing.timeApi.sleepMs = (ms: number) => { now += Math.max(1, ms); };
      let ticks = 0;
      Date.now = () => { ticks += 1; if (ticks > 20_000) throw new Error("readiness loop did not terminate"); return now; };
      const staged = stage(root, {
        readinessTimeoutMs: NaN,
        pollMs: 1_000,
        spawn: () => process.pid,
      });
      expect(staged).toBeNull();
    } finally {
      Date.now = realNow;
      __testing.probeApi.probeArgvSignature = realProbe;
      __testing.timeApi.sleepMs = realSleep;
    }
  });

  it("declines to signal once exit is already reflected in the child's fields", () => {
    // The case where the stored number is genuinely unsafe: a child reaped
    // BEFORE termination is called, which is what a delayed discard looks like.
    // By then the number is the OS's to hand out again, and Node's `kill` would
    // signal it regardless. A child whose exit is already reflected in
    // `exitCode`/`signalCode` is therefore never signalled.
    //
    // Note the guarantee is exactly that, and not "a reaped child is never
    // signalled": libuv reaps a batch of siblings before dispatching any of
    // their exit callbacks, so inside such a callback a sibling can be reaped
    // while its fields still read null. ISS-930 records that window and why it
    // is not reachable from this module today.
    const signals: string[] = [];
    const reaped = { exitCode: 0, signalCode: null, kill: (sig: string) => { signals.push(sig); return true; } };
    __testing.terminateChild(reaped as never, deadPid());
    expect(signals).toEqual([]);

    const signalled = { exitCode: null as number | null, signalCode: null, kill: (sig: string) => { signals.push(sig); return true; } };
    __testing.terminateChild(signalled as never, deadPid());
    // A live-looking child is signalled, and the dead pid ends the grace wait
    // immediately via ESRCH, so nothing escalates.
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL for a real child that refuses SIGTERM", async () => {
    // The grace path end to end, against an actual process rather than a mock.
    // A mock cannot stand in for this: the interesting behaviour is what the OS
    // and Node do with a real child, and a synchronous fake can be made to
    // report transitions that a real `ChildProcess` cannot perform while the
    // event loop is blocked.
    const { child, exit, dispose } = stubbornChild();
    try {
      // Let the child install its handler, or SIGTERM would win on timing alone
      // and the escalation this test is about would never be reached.
      await new Promise((r) => setTimeout(r, 250));
      const started = Date.now();
      __testing.terminateChild(child, child.pid!);
      const elapsed = Date.now() - started;
      await exit;
      expect(child.signalCode).toBe("SIGKILL");
      // The grace window was actually GRANTED, not skipped. Escalating straight
      // to SIGKILL also ends with the child dead, so the eventual signal alone
      // proves nothing about whether the child was given a chance to stop.
      expect(elapsed).toBeGreaterThanOrEqual(400);
    } finally {
      await dispose();
    }
  });

  it("does not turn the event loop while terminating, which is what pins the pid", async () => {
    // The load-bearing invariant, asserted directly. A number can only be
    // recycled once the parent reaps the child; Node reaps on the event loop;
    // this wait blocks that loop. So a child that exits mid-wait stays a zombie
    // holding its own number and no signal can land on a replacement. If the
    // wait is ever made async, that guarantee silently disappears -- and this
    // test fails, which is the only reason it exists.
    const { child, exit, dispose } = stubbornChild();
    try {
      await new Promise((r) => setTimeout(r, 250));
      let loopTurned = false;
      setTimeout(() => { loopTurned = true; }, 0);
      setImmediate(() => { loopTurned = true; });
      __testing.terminateChild(child, child.pid!);
      expect(loopTurned).toBe(false);
      await exit;
    } finally {
      await dispose();
    }
  });

  it("cannot be replayed after the handle has been spent", async () => {
    // Consuming the capability is what makes a second discard harmless. Without
    // it, a handle kept after cleanup stays a licence to act, and by then the
    // directory at that path and the process behind that handle may both belong
    // to somebody else.
    let terminations = 0;
    const realProbe = __testing.probeApi.probeArgvSignature;
    let staged: StagedHeartbeatGeneration | null = null;
    try {
      __testing.probeApi.probeArgvSignature = () => "match";
      staged = stage(root, {
        readinessTimeoutMs: 400,
        pollMs: 25,
        spawn: (dir) => {
          fs.writeFileSync(join(dir, "alive"), String(Date.now()));
          return { pid: deadPid(), terminate: () => { terminations += 1; } };
        },
      });
      expect(staged).not.toBeNull();
      discardStagedGeneration(staged!);
      expect(terminations).toBe(1);
      expect(fs.existsSync(staged!.dir)).toBe(false);

      discardStagedGeneration(staged!);
      expect(terminations).toBe(1);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
    }
  });

  it("removes the staged generation it was handed", () => {
    const staged = stageHeartbeatGeneration(root, { intervalMs: 50, readinessTimeoutMs: 5_000 });
    expect(staged).not.toBeNull();
    discardStagedGeneration(staged!);
    expect(fs.existsSync(staged!.dir)).toBe(false);
    expect(__testing.hasSidecarSignature(staged!.pid)).toBe(false);
  });
});
