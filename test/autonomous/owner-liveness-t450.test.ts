/**
 * T-450 / ISS-926: owner-gone CANDIDATE evidence.
 *
 * The governing fact, established by measurement and ratified by owner ruling:
 * owner-task death is NOT determinable from anything on disk. The sidecar
 * reports MCP-SERVER death; `lastGuideCall` is the only owner-task-bound
 * signal and it lapses for many minutes during normal work. These tests exist
 * mainly to pin the cases where the honest answer is "no offer".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  readOwnerLiveness,
  permitsRecoveryOffer,
  telemetryDirPath,
  OWNER_STALE_MS,
  currentMcpServerPid,
  mcpProcessRole,
  markMcpServerProcess,
  markMcpServerUnregistered,
  __testing,
  type OwnerLivenessVerdict,
} from "../../src/autonomous/liveness.js";
import { ServerRegistryBinder, RETRY_BACKOFF_MS } from "../../src/autonomous/mcp-binding.js";
import { refreshLease } from "../../src/autonomous/session.js";
import { registerMcpServer, unregisterMcpServer, liveMcpServers, markRegistryUnavailable, clearRegistryUnavailable } from "../../src/autonomous/mcp-registry.js";

const NOW = 1_800_000_000_000;
const FRESH = new Date(NOW - 5_000).toISOString();
const STALE = new Date(NOW - (OWNER_STALE_MS + 60_000)).toISOString();
/** Comfortably after any marker a fixture writes (markers are written "now"). */
const AFTER_MARKER = new Date(NOW + 5 * 60_000).toISOString();
/** Before any marker a fixture writes: an unrelated pre-existing server. */
const BEFORE_MARKER = new Date(NOW - 24 * 3_600_000).toISOString();
/** Between the recorded guide call and now: the RAPID-restart successor. */
const JUST_AFTER_CALL = new Date(NOW - (OWNER_STALE_MS + 30_000)).toISOString();

let dir: string;
let tDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t450-"));
  tDir = telemetryDirPath(dir);
  fs.mkdirSync(tDir, { recursive: true });
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

/** A pid that is certainly not running. */
function deadPid(): number {
  // Allocate high and verify it is absent rather than guessing.
  for (let candidate = 900_000; candidate < 900_200; candidate++) {
    try { process.kill(candidate, 0); } catch (e: any) {
      if (e?.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead pid for the fixture");
}

/**
 * Markers are stamped against the SYNTHETIC clock, not wall time. `NOW` is a
 * fixed future instant, so a marker left with its real mtime would sit months
 * "before" every fixture timestamp and silently invert the successor
 * comparison.
 */
const MARKER_AT = NOW - 2 * 60_000;
function stampMarker(p: string): void {
  const d = new Date(MARKER_AT);
  fs.utimesSync(p, d, d);
}
function writeAlive(v: string | number): void {
  const p = join(tDir, "alive");
  fs.writeFileSync(p, String(v));
  stampMarker(p);
}
function writeShutdown(): void {
  const p = join(tDir, "shutdown");
  fs.writeFileSync(p, "1");
  stampMarker(p);
}
function writeSidecarPid(pid: number): void { fs.writeFileSync(join(tDir, "sidecar.pid"), String(pid)); }

type OwnableState = ReturnType<Parameters<typeof readOwnerLiveness>[1]>;

function read(state: OwnableState): OwnerLivenessVerdict {
  // Default fixture: registry enumerated, nothing else running. Tests that care
  // about supersession pass their own successor set explicitly. `mcpGuideCallAt`
  // defaults to the recorded activity time, since the two are stamped together
  // in production.
  const withPair: OwnableState = state.mcpServerPid && state.mcpGuideCallAt === undefined
    ? { ...state, mcpGuideCallAt: state.lastGuideCall ?? STALE }
    : state;
  return readOwnerLiveness(dir, () => withPair, NOW, OWNER_STALE_MS,
    () => ({ kind: "observed", servers: [] }));
}

describe("T-450 owner liveness: activity outranks every process signal", () => {
  it("fresh owner activity is `active` even with a shutdown marker and a dead server pid", () => {
    writeShutdown();
    const v = read({ lastGuideCall: FRESH, mcpServerPid: deadPid() });
    expect(v.kind).toBe("active");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("absent lastGuideCall is undetermined, never a candidate", () => {
    writeShutdown();
    const v = read({ lastGuideCall: null, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("owner activity");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("unparseable lastGuideCall is undetermined", () => {
    writeShutdown();
    expect(read({ lastGuideCall: "not-a-date", mcpServerPid: deadPid() }).kind).toBe("undetermined");
  });

  it("future-dated lastGuideCall beyond skew is undetermined, not stale", () => {
    writeShutdown();
    const future = new Date(NOW + 10 * 60_000).toISOString();
    expect(read({ lastGuideCall: future, mcpServerPid: deadPid() }).kind).toBe("undetermined");
  });
});

describe("T-450 owner liveness: the MCP-restart false positive (ISS-926)", () => {
  /**
   * THE case that falsified the original ruling. Without the recorded-pid
   * check both conjuncts pass and a fully live owner is offered for takeover.
   */
  it("a live recorded MCP server pid invalidates a stale death marker", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: process.pid });
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "contradicted" && v.why).toContain("still alive");
  });

  /**
   * THE REAL RESTART SEQUENCE, and the one the first version of this suite
   * missed: the recorded server is DEAD (it is the one that exited), its
   * marker is on disk, its sidecar is gone, and the owner has not called since.
   * Every signal tied to the old server says "gone". Only the live SUCCESSOR
   * distinguishes this from the client actually going away.
   */
  it("a live successor server supersedes a dead recorded server's death marker", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const oldServer = deadPid();
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: oldServer, mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [{ pid: process.pid, registeredAt: AFTER_MARKER }] }));
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "contradicted" && v.why).toContain("superseded");
  });

  it("with NO successor running, the same evidence is a candidate", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  it("an unreadable successor registry suppresses rather than guesses", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "unavailable", reason: "registry unreadable (EACCES)" }));
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("the recorded server appearing in its own successor list is not a successor", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const stale = deadPid();
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: stale, mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [{ pid: stale, registeredAt: AFTER_MARKER }] }));
    expect(v.kind).toBe("gone-candidate");
  });

  it("a PRE-EXISTING server from another client is NOT a successor", () => {
    // Two clients against one project. The other client's server has been up
    // since before this marker was written, so it proves nothing about it.
    // Counting it would suppress recovery on this machine permanently.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [{ pid: process.pid, registeredAt: BEFORE_MARKER }] }));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  it("a successor with an unreadable registration time suppresses", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [{ pid: process.pid, registeredAt: null }] }));
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("successor-time-unknown");
  });

  it("the same suppression applies to an alive-zero marker", () => {
    writeAlive(0);
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: process.pid });
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a sidecar pid file naming OUR OWN pid is rejected, and suppresses", () => {
    // `readSidecarPid` refuses self/parent/init pids, so this yields no usable
    // sidecar identity at all. That ambiguity must suppress, not authorize.
    writeAlive(0);
    writeSidecarPid(process.pid);
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a legacy session with NO recorded server pid never reaches a candidate", () => {
    // The marker says a server exited. Without a recorded pid there is nothing
    // tying it to the server THIS session had, which is the ambiguity that has
    // to suppress rather than authorize.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE });
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "undetermined" && v.missing[0]).toContain("no-recorded-pid");
  });
});

describe("T-450: a CLI process must never record itself as the session's MCP server", () => {
  /**
   * `refreshLease` has CLI callers (`session compact-prepare`, limit-stop).
   * Recording one of those pids is worse than recording nothing: the process
   * exits at once, and its corpse then reads as "this session's server is
   * gone", manufacturing the exact false positive the field exists to prevent.
   */
  it("currentMcpServerPid is null outside an MCP server process", () => {
    expect(currentMcpServerPid()).toBeNull();
  });

  it("refreshLease leaves an existing recorded pid untouched when not an MCP server", () => {
    const base = { lease: {}, lastGuideCall: null, guideCallCount: 0, mcpServerPid: 4242,
      contextPressure: {}, completedTickets: [], resolvedIssues: [] } as any;
    expect(refreshLease(base).mcpServerPid).toBe(4242);
  });
});

describe("T-450 owner liveness: candidates", () => {
  it("stale activity + shutdown marker + dead server pid is a candidate", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  it("stale activity + alive-zero + dead server pid is a candidate", () => {
    writeAlive(0);
    writeSidecarPid(deadPid());
    expect(read({ lastGuideCall: STALE, mcpServerPid: deadPid() }).kind).toBe("gone-candidate");
  });

  it("no marker, stale alive file, provably absent sidecar is a candidate (SIGKILL/reboot)", () => {
    writeAlive(NOW - (OWNER_STALE_MS + 60_000));
    writeSidecarPid(deadPid());
    expect(read({ lastGuideCall: STALE, mcpServerPid: deadPid() }).kind).toBe("gone-candidate");
  });
});

describe("T-450 owner liveness: fails closed on the OFFER", () => {
  it("a still-ticking alive file contradicts, even with stale activity", () => {
    writeAlive(NOW - 1_000);
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a missing sidecar pid file with no death marker is undetermined, not a candidate", () => {
    writeAlive(NOW - (OWNER_STALE_MS + 60_000));
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("sidecar process identity");
  });

  it("a malformed sidecar pid file is undetermined, not a candidate", () => {
    writeAlive(NOW - (OWNER_STALE_MS + 60_000));
    fs.writeFileSync(join(tDir, "sidecar.pid"), "not-a-pid");
    expect(read({ lastGuideCall: STALE, mcpServerPid: deadPid() }).kind).toBe("undetermined");
  });

  it("an absent alive file is undetermined and names the missing evidence", () => {
    // A resolvable absent sidecar so the alive-file reason is the one that
    // surfaces rather than being shadowed by the identity gate.
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("alive file");
  });

  it.each([
    ["plainly non-numeric", "garbage"],
    ["EMPTY (the writeFileSync truncation race)", ""],
    ["whitespace only", "   "],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["exponent notation", "1e3"],
    ["hexadecimal", "0x10"],
    ["beyond MAX_SAFE_INTEGER", "99999999999999999999"],
  ])("a %s alive file is undetermined, never a death marker", (_label, raw) => {
    // `Number("")` is 0, so without strict parsing a file caught mid-write
    // would manufacture a death marker out of a concurrent truncation.
    writeAlive(raw);
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a future-dated alive file is undetermined, never a candidate", () => {
    writeAlive(NOW + 10 * 60_000);
    writeSidecarPid(deadPid());
    expect(read({ lastGuideCall: STALE, mcpServerPid: deadPid() }).kind).toBe("undetermined");
  });

  it("no recorded MCP pid does not by itself authorize an offer path it otherwise fails", () => {
    // Legacy session with no recorded pid: marker validity is unknown, so the
    // decision falls to the remaining signals rather than defaulting either way.
    writeAlive(NOW - 1_000);
    writeSidecarPid(deadPid());
    expect(read({ lastGuideCall: STALE }).kind).toBe("contradicted");
  });
});

describe("T-450 owner liveness: an UNKNOWN process probe never corroborates death", () => {
  /**
   * The arm that cannot be reached from on-disk fixtures, and the one the
   * ruling's fail-closed requirement leans on hardest. Before this seam
   * existed, collapsing the tri-state survived the entire suite.
   */
  const original = __testing.probeApi.probeArgvSignature;
  afterEach(() => { __testing.probeApi.probeArgvSignature = original; });

  it("stale activity + no death marker + UNKNOWN probe is undetermined, not a candidate", () => {
    __testing.probeApi.probeArgvSignature = () => "unknown";
    writeAlive(NOW - (OWNER_STALE_MS + 60_000));
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "undetermined" && v.missing[0]).toContain("probe-unknown");
  });

  it("an UNKNOWN probe SUPPRESSES the offer even beside a positive death marker", () => {
    // A marker attests that a server went away; it cannot say which. With the
    // sidecar's identity unreadable, the evidence is ambiguous, and the binding
    // rule is that ambiguity means no offer.
    __testing.probeApi.probeArgvSignature = () => "unknown";
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a MATCHing probe contradicts a death marker", () => {
    __testing.probeApi.probeArgvSignature = () => "match";
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });
});

describe("T-450 owner liveness: signals are always fully populated", () => {
  it("every verdict carries all four signals, the observation time and the threshold", () => {
    writeShutdown();
    for (const state of [
      { lastGuideCall: FRESH, mcpServerPid: process.pid },
      { lastGuideCall: STALE, mcpServerPid: deadPid() },
      { lastGuideCall: null, mcpServerPid: null },
    ]) {
      const s = read(state).signals;
      expect(s.activity).toBeDefined();
      expect(s.deathMarker).toBeDefined();
      expect(s.markerValidity).toBeDefined();
      expect(s.sidecarProbe).toBeDefined();
      expect(s.observedAt).toBe(new Date(NOW).toISOString());
      expect(s.staleThresholdMs).toBe(OWNER_STALE_MS);
    }
  });
});

describe("T-450: no surface claims a determination (ruling A)", () => {
  it("no verdict kind, reason or rationale asserts the owner is dead", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const verdicts = [
      read({ lastGuideCall: FRESH, mcpServerPid: process.pid }),
      read({ lastGuideCall: STALE, mcpServerPid: deadPid() }),
      read({ lastGuideCall: STALE, mcpServerPid: process.pid }),
      read({ lastGuideCall: null }),
    ];
    const forbidden = /\bowner (is )?dead\b|\bis dead\b|\bconfirmed dead\b|\bowner died\b/i;
    for (const v of verdicts) {
      expect(JSON.stringify(v)).not.toMatch(forbidden);
    }
    // And the one kind that permits an offer is spelled as a candidate.
    expect(verdicts.some((v) => v.kind === "gone-candidate")).toBe(true);
  });
});

describe("T-450: only ESRCH may corroborate a death marker", () => {
  const original = __testing.probeApi.killProbe;
  afterEach(() => { __testing.probeApi.killProbe = original; });

  const err = (code: string) => () => { const e: any = new Error(code); e.code = code; throw e; };

  it("a live recorded pid invalidates", () => {
    __testing.probeApi.killProbe = () => { /* alive */ };
    writeShutdown(); writeSidecarPid(deadPid());
    expect(read({ lastGuideCall: STALE, mcpServerPid: 1234 }).kind).toBe("contradicted");
  });

  it("EPERM invalidates (something occupies the pid, so suppress)", () => {
    __testing.probeApi.killProbe = err("EPERM");
    writeShutdown(); writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: 1234 });
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it.each([["EIO"], ["EINVAL"], ["EACCES"]])(
    "an unexpected %s from the pid probe is undetermined, never corroboration",
    (code) => {
      __testing.probeApi.killProbe = err(code);
      writeShutdown(); writeSidecarPid(deadPid());
      const v = read({ lastGuideCall: STALE, mcpServerPid: 1234 });
      expect(v.kind).toBe("undetermined");
      expect(permitsRecoveryOffer(v)).toBe(false);
      expect(v.kind === "undetermined" && v.missing[0]).toContain("pid-probe-failed");
    });

  it("ESRCH alone permits the candidate", () => {
    __testing.probeApi.killProbe = err("ESRCH");
    writeShutdown(); writeSidecarPid(deadPid());
    expect(read({ lastGuideCall: STALE, mcpServerPid: 1234 }).kind).toBe("gone-candidate");
  });
});

describe("T-450: the lease signal travels with the rest of the evidence", () => {
  it("a live lease is captured with its remaining time", () => {
    writeShutdown(); writeSidecarPid(deadPid());
    const expiresAt = new Date(NOW + 20 * 60_000).toISOString();
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid(), lease: { expiresAt } } as any);
    expect(v.signals.lease).toEqual({ kind: "live", expiresAt, remainingMs: 20 * 60_000 });
  });

  it("an expired lease is captured as expired, not as absent", () => {
    const expiresAt = new Date(NOW - 60_000).toISOString();
    const v = read({ lastGuideCall: STALE, lease: { expiresAt } } as any);
    expect(v.signals.lease).toEqual({ kind: "expired", expiresAt, agoMs: 60_000 });
  });

  it.each([[null, "absent"], ["nonsense", "unparseable"]])(
    "a %s lease reads as unknown/%s", (expiresAt, reason) => {
      const v = read({ lastGuideCall: STALE, lease: { expiresAt } } as any);
      expect(v.signals.lease).toEqual({ kind: "unknown", reason });
    });
});

describe("T-450: the marker read is a consistent snapshot", () => {
  it("a shutdown path that is a DIRECTORY is not evidence", () => {
    fs.mkdirSync(join(tDir, "shutdown"));
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a future-dated shutdown marker is not evidence", () => {
    writeShutdown();
    const future = new Date(NOW + 10 * 60_000);
    fs.utimesSync(join(tDir, "shutdown"), future, future);
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("alive-zero always carries a real timestamp when it is evidence", () => {
    writeAlive(0); writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid() });
    expect(v.kind).toBe("gone-candidate");
    expect(v.signals.deathMarker.kind).toBe("alive-zero");
    expect(v.signals.deathMarker.kind === "alive-zero" && v.signals.deathMarker.at).toBeTruthy();
  });
});

describe("T-450: the MCP server registry itself", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-root-")); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("a missing registry directory is UNAVAILABLE, not an empty listing", () => {
    // Any healthy server creates this directory by registering, and the
    // process asking is normally one of them. Absence therefore means no
    // server ever registered here, so a live but unlisted server could be
    // going unseen. Reporting "observed, nothing running" would fail open,
    // and it would do so across processes where the local flag cannot reach.
    const seen = liveMcpServers(root);
    expect(seen.kind).toBe("unavailable");
    expect(seen.kind === "unavailable" && seen.reason).toContain("does not exist");
  });

  it("a registry directory that cannot be written is UNAVAILABLE", () => {
    // Observable by ANY reader, which is the point: it explains a missing
    // entry regardless of which process failed to write it.
    const dirPath = join(root, ".story", "servers");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.chmodSync(dirPath, 0o500);
    try {
      const seen = liveMcpServers(root);
      expect(seen.kind).toBe("unavailable");
      expect(seen.kind === "unavailable" && seen.reason).toContain("not writable");
    } finally { fs.chmodSync(dirPath, 0o700); }
  });

  it("registers, enumerates with a timestamp, and unregisters", () => {
    registerMcpServer(root);
    const seen = liveMcpServers(root);
    expect(seen.kind).toBe("observed");
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine).toBeTruthy();
    expect(mine && !Number.isNaN(new Date(mine.registeredAt!).getTime())).toBe(true);

    unregisterMcpServer(root);
    const after = liveMcpServers(root);
    expect(after.kind === "observed" && after.servers.some((s) => s.pid === process.pid)).toBe(false);
  });

  it("reaps dead entries while preserving live ones", () => {
    const dead = deadPid();
    registerMcpServer(root, dead);
    registerMcpServer(root, process.pid);
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers.map((s) => s.pid)).toEqual([process.pid]);
    // The reap is on disk, not just filtered in memory.
    expect(fs.existsSync(join(root, ".story", "servers", String(dead)))).toBe(false);
  });

  it("ignores non-pid filenames rather than choking on them", () => {
    fs.mkdirSync(join(root, ".story", "servers"), { recursive: true });
    fs.writeFileSync(join(root, ".story", "servers", "not-a-pid"), "x");
    registerMcpServer(root, process.pid);
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers.map((s) => s.pid)).toEqual([process.pid]);
  });

  it("an entry with an unreadable timestamp still reports the pid, with null time", () => {
    fs.mkdirSync(join(root, ".story", "servers"), { recursive: true });
    fs.writeFileSync(join(root, ".story", "servers", String(process.pid)), "not-a-date");
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers[0]).toEqual({ pid: process.pid, registeredAt: null });
  });

  it("registration failure is non-fatal", () => {
    // An unwritable root must degrade to `unavailable`, never throw: the MCP
    // server has to keep serving even with no registry.
    expect(() => registerMcpServer("/proc/nonexistent-storybloq-root")).not.toThrow();
    expect(() => unregisterMcpServer("/proc/nonexistent-storybloq-root")).not.toThrow();
  });
});

describe("T-450: the RAPID restart, where the successor predates the marker", () => {
  /**
   * The window a marker-anchored comparison misses entirely. The replacement
   * server registers the instant the client reconnects; the OLD sidecar only
   * notices reparenting on its next tick, up to 10s later. So the successor
   * legitimately registered BEFORE the marker it supersedes. Anchoring on the
   * recorded server's last guide call is what makes this visible.
   */
  it("a successor registered after the last guide call but BEFORE the marker suppresses", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir,
      () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, registeredAt: JUST_AFTER_CALL }] }),
    );
    expect(new Date(JUST_AFTER_CALL).getTime()).toBeLessThan(MARKER_AT);
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a recorded pid with NO paired timestamp cannot be placed, so it suppresses", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid() }), NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [] }),
    );
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("recorded-time-unknown");
  });

  it("the paired timestamp is carried into the evidence as recordedAt", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = read({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE });
    expect(v.kind).toBe("gone-candidate");
    expect(v.signals.markerValidity.kind === "not-invalidated"
      && v.signals.markerValidity.recordedAt).toBe(STALE);
  });
});

describe("T-450: the successor set is re-read before authorizing (TOCTOU)", () => {
  it("a successor that appears between enumeration and verdict still suppresses", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    let call = 0;
    const provider = () => {
      call += 1;
      // First read: nothing running. Second read (the pre-authorization
      // recheck): a replacement server has come up.
      return call === 1
        ? { kind: "observed" as const, servers: [] }
        : { kind: "observed" as const, servers: [{ pid: process.pid, registeredAt: JUST_AFTER_CALL }] };
    };
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, provider,
    );
    expect(call).toBeGreaterThan(1);
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a stable provider still yields the candidate", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }),
    );
    expect(v.kind).toBe("gone-candidate");
  });
});

describe("T-450: a failed registration is not recorded as a successful bind", () => {
  it("registerMcpServer reports failure rather than swallowing it", () => {
    expect(registerMcpServer("/proc/nonexistent-storybloq-root")).toBe(false);
  });

  it("registerMcpServer reports success on a writable root", () => {
    const root = mkdtempSync(join(tmpdir(), "t450-ok-"));
    try {
      expect(registerMcpServer(root)).toBe(true);
      const seen = liveMcpServers(root);
      expect(seen.kind === "observed" && seen.servers.some((s) => s.pid === process.pid)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("T-450: the recheck REPLACES the recorded evidence, not just the verdict", () => {
  it("a contradicted verdict ships the successor it names", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    let call = 0;
    const provider = () => {
      call += 1;
      return call === 1
        ? { kind: "observed" as const, servers: [] }
        : { kind: "observed" as const, servers: [{ pid: process.pid, registeredAt: JUST_AFTER_CALL }] };
    };
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, provider,
    );
    expect(v.kind).toBe("contradicted");
    // The evidence must not still claim an empty registry while the verdict
    // blames a pid that only the second read saw.
    expect(v.signals.successors).toEqual({
      kind: "observed",
      servers: [{ pid: process.pid, registeredAt: JUST_AFTER_CALL }],
    });
    expect(v.signals.markerValidity.kind === "invalidated"
      && v.signals.markerValidity.successorPids).toEqual([process.pid]);
  });
});

describe("T-450: the paired timestamp is validated, not merely parsed", () => {
  it.each([
    ["unparseable", "not-a-date"],
    ["far-future", new Date(NOW + 60 * 60_000).toISOString()],
  ])("a %s mcpGuideCallAt suppresses rather than authorizing", (_label, stamp) => {
    // A future recorded time would make every genuine successor compare as
    // older, which is fail-OPEN: the exact shape this path exists to prevent.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: stamp }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }),
    );
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "undetermined" && v.missing[0]).toContain("recorded-time-unknown");
  });

  it("recordedAt is present on the live-pid invalidated arm too", () => {
    __testing.probeApi.killProbe = () => { /* alive */ };
    try {
      writeShutdown(); writeSidecarPid(deadPid());
      const v = read({ lastGuideCall: STALE, mcpServerPid: 1234, mcpGuideCallAt: STALE });
      expect(v.signals.markerValidity.kind).toBe("invalidated");
      expect(v.signals.markerValidity.kind === "invalidated"
        && v.signals.markerValidity.recordedAt).toBe(STALE);
    } finally { __testing.probeApi.killProbe = (pid: number) => { process.kill(pid, 0); }; }
  });
});

describe("T-450: a server that could not register makes the registry unavailable", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-unreg-")); });
  afterEach(() => {
    clearRegistryUnavailable(root);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("an unregistered live server turns enumeration into `unavailable`", () => {
    // Otherwise this very process is a live successor missing from the listing,
    // and a predecessor's session would read "nothing running" and authorize.
    registerMcpServer(root);
    expect(liveMcpServers(root).kind).toBe("observed");
    markRegistryUnavailable(root);
    expect(liveMcpServers(root).kind).toBe("unavailable");
  });

  it("and that unavailability suppresses the offer end to end", () => {
    markRegistryUnavailable(root);
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => liveMcpServers(root),
    );
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a later successful registration clears it", () => {
    markRegistryUnavailable(root);
    expect(liveMcpServers(root).kind).toBe("unavailable");
    expect(registerMcpServer(root)).toBe(true);
    expect(liveMcpServers(root).kind).toBe("observed");
  });
});

describe("T-450: the OWNER's own state is re-read before authorizing", () => {
  it("an owner that becomes active mid-evaluation is not offered", () => {
    // The sequence a registry-only recheck misses entirely: no successor ever
    // appears, because a CLI `compact-prepare` advances `lastGuideCall` and
    // registers nothing. Only re-reading the owner's state catches it.
    writeShutdown();
    writeSidecarPid(deadPid());
    let reads = 0;
    const stateProvider = () => {
      reads += 1;
      return reads === 1
        ? { lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }
        : { lastGuideCall: FRESH, mcpServerPid: deadPid(), mcpGuideCallAt: STALE };
    };
    const v = readOwnerLiveness(dir, stateProvider, NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [] }));
    expect(reads).toBeGreaterThan(1);
    expect(v.kind).toBe("active");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.signals.activity.kind).toBe("fresh");
  });

  it("an owner that stays stale still yields the candidate", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("gone-candidate");
  });
});

describe("T-450: successor ordering survives a backward clock step", () => {
  it("a successor registered slightly BEFORE the anchor still suppresses", () => {
    // A backward clock adjustment between the predecessor's guide call and the
    // successor's registration gives the genuine successor an earlier
    // timestamp. Strict ordering would ignore it and authorize on a live owner.
    writeShutdown();
    writeSidecarPid(deadPid());
    const justBefore = new Date(new Date(STALE).getTime() - 5_000).toISOString();
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, registeredAt: justBefore }] }));
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a server from well before the anchor is still not a successor", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, registeredAt: BEFORE_MARKER }] }));
    expect(v.kind).toBe("gone-candidate");
  });
});

describe("T-450: the owner-state check is the LAST thing before authorizing", () => {
  /** Owner refreshes AFTER the registry read. Only a state read that comes
   *  after the registry read can catch it. */
  it("an owner that becomes active after the registry read is not offered", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    let stateReads = 0;
    let ownerActive = false;
    const readState = () => {
      stateReads += 1;
      return ownerActive
        ? { lastGuideCall: FRESH, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }
        : { lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE };
    };
    let registryReads = 0;
    const readSuccessors = () => {
      registryReads += 1;
      // Flip on the SECOND read only. The first happens while the initial
      // signals are built, long before authorization; flipping there would
      // make the test pass whatever the order, which is exactly how an earlier
      // version of it failed to pin anything.
      if (registryReads >= 2) ownerActive = true;
      return { kind: "observed" as const, servers: [] };
    };
    const v = readOwnerLiveness(dir, readState, NOW, OWNER_STALE_MS, readSuccessors);
    expect(stateReads).toBeGreaterThan(1);
    expect(v.kind).toBe("active");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it.each([
    ["absent", null],
    ["unparseable", "not-a-date"],
    ["future-dated", new Date(NOW + 30 * 60_000).toISOString()],
  ])("a recheck whose activity becomes %s suppresses rather than falling through", (_l, value) => {
    // `unknown` is not `stale`. Continuing on it would authorize using activity
    // evidence we had just failed to confirm.
    writeShutdown();
    writeSidecarPid(deadPid());
    let n = 0;
    const readState = () => {
      n += 1;
      return n === 1
        ? { lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }
        : { lastGuideCall: value, mcpServerPid: deadPid(), mcpGuideCallAt: STALE };
    };
    const v = readOwnerLiveness(dir, readState, NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "undetermined" && v.missing[0]).toContain("recheck");
  });
});

describe("T-450: an UNREGISTERED server clears the predecessor's pid pair", () => {
  const base = () => ({
    lease: {}, lastGuideCall: null, guideCallCount: 0,
    mcpServerPid: 4242, mcpGuideCallAt: STALE,
    contextPressure: {}, completedTickets: [], resolvedIssues: [],
  }) as any;

  afterEach(() => { __testing.setProcessRole("cli"); });

  it("a CLI refresh PRESERVES the pair (it is not a server)", () => {
    __testing.setProcessRole("cli");
    const out = refreshLease(base());
    expect(out.mcpServerPid).toBe(4242);
    expect(out.mcpGuideCallAt).toBe(STALE);
  });

  it("a REGISTERED server stamps both fields together", () => {
    __testing.setProcessRole("mcp-registered");
    const out = refreshLease(base());
    expect(out.mcpServerPid).toBe(process.pid);
    expect(out.mcpGuideCallAt).toBe(out.lastGuideCall);
  });

  it("an UNREGISTERED server CLEARS the pair rather than preserving it", () => {
    // Otherwise: predecessor A stamps and dies; replacement B fails to
    // register; B serves a guide call, advancing lastGuideCall while leaving
    // A's dead pid recorded. Another evaluator then sees stale activity, dead
    // A, no registered successor, and a marker, and authorizes against a live
    // owner. Clearing makes that read `no-recorded-pid`, which suppresses.
    __testing.setProcessRole("mcp-unregistered");
    const out = refreshLease(base());
    expect(out.mcpServerPid ?? null).toBeNull();
    expect(out.mcpGuideCallAt ?? null).toBeNull();
  });

  it("and the cleared pair yields no offer", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: undefined, mcpGuideCallAt: undefined }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
    expect(v.kind === "undetermined" && v.missing[0]).toContain("no-recorded-pid");
  });
});

describe("T-450: the no-refresh window closes without depending on a refresh", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-win-")); });
  afterEach(() => {
    clearRegistryUnavailable(root);
    __testing.setProcessRole("cli");
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /**
   * The sequence clearing alone does NOT cover: predecessor A leaves a stale
   * session carrying its pair, A dies, replacement B fails to register, and
   * the owner keeps working without another guide call, so B never touches
   * that session. Two independent mechanisms have to close it, because
   * clearing needs a refresh that never comes.
   */
  it("PERMANENT failure: an unwritable registry reads as unavailable for ANY process", () => {
    const dirPath = join(root, ".story", "servers");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.chmodSync(dirPath, 0o500);
    try {
      // No process-local flag involved: a different evaluator sees this too.
      const seen = liveMcpServers(root);
      expect(seen.kind).toBe("unavailable");

      writeShutdown();
      writeSidecarPid(deadPid());
      const v = readOwnerLiveness(
        dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
        NOW, OWNER_STALE_MS, () => liveMcpServers(root));
      expect(v.kind).toBe("undetermined");
      expect(permitsRecoveryOffer(v)).toBe(false);
    } finally { fs.chmodSync(dirPath, 0o700); }
  });

  it("TRANSIENT failure: a later retry registers and the server becomes visible", () => {
    // Registration fails while the path is unusable, then succeeds once it is
    // not. The retry is what stops a transient failure from leaving this
    // server invisible forever.
    const blocked = join(root, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    expect(registerMcpServer(blocked)).toBe(false);
    expect(liveMcpServers(blocked).kind).toBe("unavailable");

    // The path becomes usable; the retry path is just another call.
    fs.unlinkSync(blocked);
    expect(registerMcpServer(blocked)).toBe(true);
    const seen = liveMcpServers(blocked);
    expect(seen.kind).toBe("observed");
    expect(seen.kind === "observed" && seen.servers.some((s) => s.pid === process.pid)).toBe(true);
  });

});

/**
 * The retry WINDOW, driven through the real binder rather than by calling
 * `registerMcpServer` twice by hand.
 *
 * Calling the registry directly proves the registry works. It does not prove
 * the thing that actually bounds the exposure: that a server which fails to
 * register schedules its own retry, that the first retry is fast rather than a
 * 30-second tick, and that its own evaluations stay suppressed until the retry
 * lands. Those are properties of the BINDER, so these tests drive the binder
 * with an injected scheduler and fire its timers explicitly.
 */
describe("T-450: the binder bounds its own invisible window", () => {
  let root: string;
  let blocked: string;

  /** Records what the binder scheduled instead of arming a real timer. */
  function fakeScheduler() {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean; fired: boolean }> = [];
    return {
      timers,
      schedule(fn: () => void, ms: number) {
        const t = { fn, ms, cancelled: false, fired: false };
        timers.push(t);
        return { cancel: () => { t.cancelled = true; } };
      },
      /** Fire the most recently scheduled live timer, as a real clock would. */
      fire() {
        const t = timers[timers.length - 1];
        if (!t || t.cancelled || t.fired) throw new Error("no live timer to fire");
        // A one-shot timer is spent once it runs, so it stops counting as
        // pending. Without this the count conflates "armed" with "ever armed".
        t.fired = true;
        t.fn();
      },
      /** Armed and not yet run: what a real event loop would still be holding. */
      live() { return timers.filter((t) => !t.cancelled && !t.fired); },
    };
  }

  /** Records exit wiring instead of attaching listeners to the real process. */
  let exitReleases: Array<() => void>;

  function binderWith(sched: ReturnType<typeof fakeScheduler>) {
    return new ServerRegistryBinder({
      register: registerMcpServer,
      unregister: unregisterMcpServer,
      markUnavailable: markRegistryUnavailable,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet in tests */ },
    });
  }

  /**
   * Evaluate as a DIFFERENT process would: no access to this process's
   * `unregisteredRoots` flag, which is exactly the asymmetry that makes the
   * residual window real. Clearing the flag is the whole point of the helper,
   * not a shortcut around one.
   */
  function evaluateAsThirdParty(registryRoot: string, guideCallAt: string) {
    clearRegistryUnavailable(registryRoot);
    return readOwnerLiveness(
      dir,
      () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: guideCallAt }),
      NOW, OWNER_STALE_MS, () => liveMcpServers(registryRoot));
  }

  beforeEach(() => {
    exitReleases = [];
    root = mkdtempSync(join(tmpdir(), "t450-bind-"));
    blocked = join(root, "blocked");
    // A regular file where a directory must go: registration fails, and it can
    // be cleared mid-test exactly like a transient cause.
    fs.writeFileSync(blocked, "not a directory");
  });
  afterEach(() => {
    clearRegistryUnavailable(blocked);
    clearRegistryUnavailable(root);
    unregisterMcpServer(blocked);
    __testing.setProcessRole("cli");
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("the FIRST retry is fast, not a 30-second tick", () => {
    // This is the finding in literal form. A 30-second first retry leaves a
    // 30-second window in which a transient cause has already cleared and this
    // server is still unlisted. Sub-second first retries are the bound.
    expect(RETRY_BACKOFF_MS[0]).toBeLessThanOrEqual(250);

    const sched = fakeScheduler();
    binderWith(sched).bind(blocked);
    expect(sched.live()).toHaveLength(1);
    expect(sched.timers[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);
  });

  it("a failed bind marks the role unregistered and the registry unavailable", () => {
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(blocked);

    expect(binder.root).toBeNull();
    expect(binder.retrying).toBe(true);
    // Not registered, so it stamps no pid: a session it serves carries no
    // recorded pid, which reads as `no-recorded-pid` and suppresses.
    expect(mcpProcessRole()).toBe("mcp-unregistered");
    expect(currentMcpServerPid()).toBeNull();
    expect(liveMcpServers(blocked).kind).toBe("unavailable");
  });

  it("THIS process suppresses itself for the whole window", () => {
    // The half that IS closed. A server that knows it failed to register makes
    // its own reads unavailable, so nothing it evaluates can authorize.
    const sched = fakeScheduler();
    binderWith(sched).bind(blocked);

    writeShutdown();
    writeSidecarPid(deadPid());
    const own = readOwnerLiveness(
      dir, () => ({ lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => liveMcpServers(blocked));
    expect(own.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(own)).toBe(false);
  });

  it("the window is BOUNDED, not closed: a third evaluator can reach a candidate until the retry lands", () => {
    // The honest statement of the residual, pinned so nobody later reads the
    // suppression test above and concludes the window is gone. A process-local
    // flag cannot reach another process; only the registry entry can, and
    // between the cause clearing and the retry landing there is no entry.
    //
    // `guideCallAt` sits far enough back that the successor's real registration
    // timestamp is unambiguously after it, which is what makes it a successor.
    const guideCallAt = new Date(NOW - 5 * 365 * 24 * 3_600_000).toISOString();
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(blocked);

    writeShutdown();
    writeSidecarPid(deadPid());

    // The transient cause clears, and a registry left behind by an earlier
    // server is readable, writable and empty. The binder's retry has not run.
    fs.unlinkSync(blocked);
    fs.mkdirSync(join(blocked, ".story", "servers"), { recursive: true });

    const duringWindow = evaluateAsThirdParty(blocked, guideCallAt);
    expect(duringWindow.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(duringWindow)).toBe(true);

    // Firing the timer is what closes it, and the first one is sub-second.
    expect(sched.timers[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);
    sched.fire();
    expect(binder.root).toBe(blocked);
    expect(binder.retrying).toBe(false);
    expect(mcpProcessRole()).toBe("mcp-registered");

    const registered = liveMcpServers(blocked);
    expect(registered.kind).toBe("observed");
    expect(registered.kind === "observed" && registered.servers.some((s) => s.pid === process.pid)).toBe(true);

    // Same evaluator, same evidence, and now suppressed: the live successor
    // supersedes the death marker.
    const afterRetry = evaluateAsThirdParty(blocked, guideCallAt);
    expect(afterRetry.kind).not.toBe("gone-candidate");
    expect(permitsRecoveryOffer(afterRetry)).toBe(false);
  });

  it("rebinding to a DIFFERENT root moves the entry and leaves no retry armed", () => {
    const rootA = join(root, "a");
    const rootB = join(root, "b");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    try {
      const sched = fakeScheduler();
      const binder = binderWith(sched);
      binder.bind(rootA);
      expect(binder.root).toBe(rootA);
      const a = liveMcpServers(rootA);
      expect(a.kind === "observed" && a.servers.some((s) => s.pid === process.pid)).toBe(true);

      binder.bind(rootB);
      expect(binder.root).toBe(rootB);
      expect(mcpProcessRole()).toBe("mcp-registered");
      expect(sched.live()).toHaveLength(0);

      // A's entry is gone, so A no longer reports this process as a successor.
      const aAfter = liveMcpServers(rootA);
      expect(aAfter.kind === "observed" && aAfter.servers.some((s) => s.pid === process.pid)).toBe(false);
      const b = liveMcpServers(rootB);
      expect(b.kind === "observed" && b.servers.some((s) => s.pid === process.pid)).toBe(true);
    } finally {
      unregisterMcpServer(rootA);
      unregisterMcpServer(rootB);
    }
  });

  it("exit wiring is installed once, not per successful bind", () => {
    const rootA = join(root, "a2");
    const rootB = join(root, "b2");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    try {
      const sched = fakeScheduler();
      const binder = binderWith(sched);
      binder.bind(rootA);
      binder.bind(rootB);
      expect(exitReleases).toHaveLength(1);

      // And the wiring releases the CURRENT root, not the one it was created on.
      exitReleases[0]?.();
      const b = liveMcpServers(rootB);
      expect(b.kind === "observed" && b.servers.some((s) => s.pid === process.pid)).toBe(false);
    } finally {
      unregisterMcpServer(rootA);
      unregisterMcpServer(rootB);
    }
  });

  it("backoff escalates across repeated failures and saturates at the last step", () => {
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(blocked);
    // Each fire re-attempts against a path that is still blocked, so each one
    // reschedules at the next step.
    for (let i = 1; i < RETRY_BACKOFF_MS.length + 2; i++) sched.fire();

    const scheduled = sched.timers.map((t) => t.ms);
    expect(scheduled.slice(0, RETRY_BACKOFF_MS.length)).toEqual([...RETRY_BACKOFF_MS]);
    const last = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    for (const ms of scheduled.slice(RETRY_BACKOFF_MS.length)) expect(ms).toBe(last);
  });

  it("a repeated bind while a retry is pending does not stack timers", () => {
    // Reachable, not theoretical: startup binds and fails, then a
    // `storybloq_init` in the same still-degraded server binds the same root.
    // Without a single-pending guard each failing call arms another timer, and
    // each firing timer arms more, so a persistently unwritable registry turns
    // into a growing pile of retries.
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(blocked);
    binder.bind(blocked);
    binder.bind(blocked);
    expect(sched.live()).toHaveLength(1);

    // Firing consumes the one timer and arms exactly one replacement.
    sched.fire();
    expect(sched.live()).toHaveLength(1);
    expect(sched.timers).toHaveLength(2);
  });

  it("a successful bind cancels the pending retry and does not schedule another", () => {
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(blocked);
    expect(sched.live()).toHaveLength(1);

    fs.unlinkSync(blocked);
    // A second bind call arriving before the timer, which is what happens when
    // `storybloq_init` binds a server that started degraded.
    binder.bind(blocked);
    expect(binder.root).toBe(blocked);
    expect(sched.live()).toHaveLength(0);
    expect(binder.retrying).toBe(false);

    // Idempotent: binding the same root again is a no-op, not a re-register.
    binder.bind(blocked);
    expect(sched.timers).toHaveLength(1);
  });

  it("binding is a no-op for a null root and never schedules a retry", () => {
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(null);
    binder.bind(undefined);
    binder.bind("");
    expect(binder.root).toBeNull();
    expect(sched.timers).toHaveLength(0);
    // Role untouched: a degraded server that never learned a root is a CLI-like
    // process, not an unregistered server.
    expect(mcpProcessRole()).toBe("cli");
  });

  it("a register that THROWS is treated as failure, not as a bind", () => {
    const sched = fakeScheduler();
    let marked = false;
    const binder = new ServerRegistryBinder({
      register: () => { throw new Error("registry exploded"); },
      unregister: () => { /* noop */ },
      markUnavailable: () => { marked = true; },
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    expect(() => binder.bind(root)).not.toThrow();
    expect(marked).toBe(true);
    expect(binder.root).toBeNull();
    expect(binder.retrying).toBe(true);
    expect(mcpProcessRole()).toBe("mcp-unregistered");
  });
});
