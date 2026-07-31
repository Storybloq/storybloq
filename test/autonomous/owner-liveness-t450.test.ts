/**
 * T-450 / ISS-926: owner-gone CANDIDATE evidence.
 *
 * The governing fact, established by measurement and ratified by owner ruling:
 * owner-task death is NOT determinable from anything on disk. The sidecar
 * reports MCP-SERVER death; within the session's own state `lastGuideCall` is
 * the only owner-task-bound signal, and it lapses for many minutes during
 * normal work. (The registry adds one from outside that state: a live entry
 * carrying the owner's identity. It proves life, never death.) These tests exist
 * mainly to pin the cases where the honest answer is "no offer".
 *
 * SUCCESSION IS IDENTITY-BOUND (ruling C-2, superseding ruling C's successor
 * clause). The first version of this suite pinned a TEMPORAL predicate: a
 * server that registered after the recorded server's last guide call counted as
 * its continuation. That is wrong in the direction that matters most. Every
 * fresh client registers after a dead server's last guide call, including the
 * recovery client that is evaluating the offer and registered itself at its own
 * startup, so the evaluator counted ITSELF as a superseding successor and the
 * offer could never fire from anyone who arrived to recover. Anchoring on
 * marker time instead fails the other way, because an in-place restart
 * registers the true successor before the orphaned sidecar writes its marker.
 *
 * The question was never "is some server newer". It is "is the OWNER's client
 * alive somewhere else right now". On succession grounds only an identity
 * MATCH invalidates the marker, and an entry that cannot be attributed
 * withholds the offer instead, via `undetermined`. (The recorded server's own
 * pid being alive invalidates the marker too, on separate grounds.) `registeredAt` is display and audit only, and nothing in the
 * predicate reads it. Tests here vary identity and hold time constant, and several
 * deliberately vary time across implausible extremes to prove it is inert.
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
import {
  registerMcpServer,
  reassertMcpServerIdentity,
  unregisterMcpServer,
  liveMcpServers,
  clearSelfVouch,
  selfVouch,
  type RegisteredServer,
} from "../../src/autonomous/mcp-registry.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";

const NOW = 1_800_000_000_000;
const FRESH = new Date(NOW - 5_000).toISOString();
const STALE = new Date(NOW - (OWNER_STALE_MS + 60_000)).toISOString();
/**
 * Filler registration time. Inert to the liveness predicate under ruling C-2,
 * though it does reach the evidence fingerprint; see `server()`.
 */
const REGISTERED_AT = new Date(NOW - 3 * 60_000).toISOString();

/**
 * The session owner's client task. Succession turns on THIS, and on nothing
 * temporal (ruling C-2).
 */
const OWNER: OwnerTask = { client: "claude", id: "owner-task-aaa", boundAt: STALE };
/**
 * A different task on the same client, and the shape that matters most: this is
 * the RECOVERY client. A fresh Claude Code task registers itself at server
 * startup and then evaluates the offer. Under the rejected temporal predicate it
 * registered after the dead server's last guide call, so it counted as its own
 * superseding successor and the offer could never fire.
 */
const OTHER: OwnerTask = { client: "claude", id: "other-task-bbb", boundAt: STALE };
/**
 * The owner's task id under a different client. Task ids are per-client
 * namespaces, so this is a different task despite the identical id.
 */
const OWNER_ID_OTHER_CLIENT: OwnerTask = { client: "codex", id: "owner-task-aaa", boundAt: STALE };

/**
 * A live registry entry.
 *
 * Every fixture built through THIS helper carries the same `registeredAt` on
 * purpose. Under ruling C-2 that field is display and audit only, so no test
 * may depend on its value; if one starts to, it can only be through a code path
 * that reads it. Tests that need an unusual registration time build their
 * entries directly, and several do so at implausible extremes precisely to
 * prove the field is inert.
 */
function server(pid: number, identity: OwnerTask | null): RegisteredServer {
  return { pid, identity, registeredAt: REGISTERED_AT };
}

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
  // Default fixture: registry enumerated, nothing else running, and the session
  // carries an owner identity, which is the post-C-2 production shape. Tests
  // that care about supersession pass their own successor set explicitly; tests
  // that care about the identity-less legacy shape pass `ownerTask: null`.
  // `mcpGuideCallAt` defaults to the recorded activity time, since the two are
  // stamped together in production.
  const withPair: OwnableState = state.mcpServerPid && state.mcpGuideCallAt === undefined
    ? { ...state, mcpGuideCallAt: state.lastGuideCall ?? STALE }
    : state;
  const withOwner: OwnableState = { ownerTask: OWNER, ...withPair };
  return readOwnerLiveness(dir, () => withOwner, NOW, OWNER_STALE_MS,
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
   * Every signal tied to the old server says "gone". Only a live server
   * belonging to the OWNER's client distinguishes this from the client actually
   * going away.
   */
  it("a live server carrying the OWNER's identity supersedes the death marker", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const oldServer = deadPid();
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: oldServer, mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(process.pid, OWNER)] }));
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
    // The rationale has to name what was actually established: the OWNER's
    // client is alive. "A newer server exists" is a different, weaker claim.
    expect(v.kind === "contradicted" && v.why).toContain("client that owns this session is still running");
  });

  it("with NO successor running, the same evidence is a candidate", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  it("an unreadable successor registry suppresses rather than guesses", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "unavailable", reason: "registry unreadable (EACCES)" }));
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("the recorded server appearing in its own successor list is not a successor", () => {
    // Its own stale entry, carrying its own owner's identity. Excluding the
    // recorded pid has to happen BEFORE the identity comparison, or the dead
    // server's leftover file proves its owner alive by pointing at itself.
    writeShutdown();
    writeSidecarPid(deadPid());
    const stale = deadPid();
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: stale, mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(stale, OWNER)] }));
    expect(v.kind).toBe("gone-candidate");
  });

  /**
   * THE DEFECT RULING C-2 NAMES, in literal form.
   *
   * The recovery client registers its own server at startup and then evaluates
   * the offer. Under the rejected temporal predicate that entry registered after
   * the dead server's last guide call, so the evaluator counted ITSELF as a
   * superseding successor, the verdict came back `contradicted`, and the offer
   * could never fire from anyone who arrived to recover. Identity is what makes
   * this reachable: the recovery client is a different task, so it supersedes
   * nothing.
   */
  it("the RECOVERY client's own live server does not suppress the offer", () => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(process.pid, OTHER)] }));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  it("a CROWD of live servers, none of them the owner's, is not a successor", () => {
    // Several clients against one project, which is the normal state of a
    // machine running more than one task. None of them says anything about
    // whether the owner's client is alive, so counting any of them would
    // suppress recovery here for as long as any other task is running.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [
        server(process.pid, OTHER),
        server(4242, { client: "claude", id: "third-task-ccc", boundAt: STALE }),
        server(4343, { client: "codex", id: "fourth-task-ddd", boundAt: STALE }),
      ] }));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  it("boundAt is not part of the identity: a re-bound owner still supersedes", () => {
    // A restarted client mints a fresh `boundAt`. Comparing whole objects would
    // stop recognizing the owner across exactly the restart this path exists to
    // survive, which is the fail-OPEN direction.
    writeShutdown();
    writeSidecarPid(deadPid());
    const rebound = { ...OWNER, boundAt: new Date(NOW - 1_000).toISOString() };
    expect(rebound.boundAt).not.toBe(OWNER.boundAt);
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(process.pid, rebound)] }));
    expect(v.kind).toBe("contradicted");
  });

  it("the same task id under a DIFFERENT client is not the owner", () => {
    // Task ids are per-client namespaces. A Codex thread that happens to carry
    // the same opaque string as a Claude session is a different task, and
    // matching on the id alone would suppress a real recovery.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(process.pid, OWNER_ID_OTHER_CLIENT)] }));
    expect(v.kind).toBe("gone-candidate");
  });

  it("an owner match still suppresses when another entry is unattributable", () => {
    // Order matters: a definite match is stronger evidence than an unreadable
    // neighbour. Checking unattributability first would downgrade a provable
    // "the owner is alive" into `undetermined`.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(4242, null), server(process.pid, OWNER)] }));
    expect(v.kind).toBe("contradicted");
    // The rationale has to name what was actually established: the OWNER's
    // client is alive. "A newer server exists" is a different, weaker claim.
    expect(v.kind === "contradicted" && v.why).toContain("client that owns this session is still running");
  });

  it("a successor with an UNATTRIBUTABLE identity suppresses, never contradicts", () => {
    // It could be the owner's. "Could be" is not positive evidence of life, so
    // it resolves to `undetermined`: no offer, and no claim either way.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(process.pid, null)] }));
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("successor-identity-unknown");
  });

  it("a session with NO recorded owner identity suppresses with its own reason", () => {
    // The accepted legacy cost: pre-C-2 sessions carry no `ownerTask`, so the
    // identity question cannot be asked at all. Fail closed, and say why.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: null, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.missing[0]).toContain("owner-identity-unrecorded");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("registeredAt is inert: an ANCIENT owner entry still supersedes", () => {
    // The rejected predicate would have ignored this entry for being older than
    // the recorded server's last guide call. Identity does not care when the
    // owner's client started, only that it is running now.
    writeShutdown();
    writeSidecarPid(deadPid());
    const ancient = new Date(NOW - 5 * 365 * 24 * 3_600_000).toISOString();
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, identity: OWNER, registeredAt: ancient }] }));
    expect(v.kind).toBe("contradicted");
  });

  it("registeredAt is inert: a null registration time on the owner's entry still supersedes", () => {
    // Under the rejected predicate an unplaceable entry suppressed into
    // `undetermined`. It is now a cosmetic loss on a display field.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }), NOW,
      OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, identity: OWNER, registeredAt: null }] }));
    expect(v.kind).toBe("contradicted");
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
  afterEach(() => {
    // The vouch is process-local state that outlives the temp directory, so a
    // test that registers has to drop it or the next one inherits a claim to a
    // root that no longer exists.
    clearSelfVouch(root);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

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

  it("registers with an IDENTITY, enumerates it, and unregisters", () => {
    expect(registerMcpServer(root, OWNER)).toBe(true);
    const seen = liveMcpServers(root);
    expect(seen.kind).toBe("observed");
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine).toBeTruthy();
    // The identity a local enumeration reports. This one goes through the
    // in-process vouch, which is the path a registered server takes for its own
    // entry; the on-disk round trip is the next test, after the vouch is
    // dropped.
    expect(mine && mine.identity).toEqual(OWNER);
    expect(mine && !Number.isNaN(new Date(mine.registeredAt!).getTime())).toBe(true);

    unregisterMcpServer(root);
    const after = liveMcpServers(root);
    expect(after.kind === "observed" && after.servers.some((s) => s.pid === process.pid)).toBe(false);
  });

  it("the identity survives a fresh read with no vouch to lean on", () => {
    // Enumerating with no vouch is how another evaluator with the same access
    // sees this entry, and it is the only path that actually exercises the
    // on-disk format. With the vouch in place the listing could return the
    // in-memory object and a serialization bug would never surface. (Same pid
    // and same permissions, so this simulates the other process rather than
    // being one.)
    registerMcpServer(root, OWNER);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
  });

  it("registering with NO identity is honest about it rather than inventing one", () => {
    // A Codex server starts with only `STORYBLOQ_CLIENT` in its environment, so
    // it genuinely has no task id until a guide call carries one.
    registerMcpServer(root, null);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toBeNull();
  });

  it("reaps dead entries while preserving live ones", () => {
    const dead = deadPid();
    registerMcpServer(root, OTHER, dead);
    registerMcpServer(root, OWNER, process.pid);
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers.map((s) => s.pid)).toEqual([process.pid]);
    // The reap is on disk, not just filtered in memory.
    expect(fs.existsSync(join(root, ".story", "servers", String(dead)))).toBe(false);
  });

  it("planting a FOREIGN pid does not make this process vouch for it", () => {
    // `pid` is a parameter so tests can plant an entry. Vouching for one would
    // have this process assert that some other pid is live, and the vouch is
    // re-added after the reap, so a dead pid would come back as a live server.
    const dead = deadPid();
    registerMcpServer(root, OTHER, dead);
    expect(selfVouch(root)).toBeUndefined();
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers.map((s) => s.pid)).toEqual([]);
  });

  it("an UNREADABLE entry is carried as unattributable, not dropped", () => {
    // Dropping it would be fail-OPEN: a live server that cannot be attributed
    // would vanish from the listing, and the predicate would then see an empty
    // registry and authorize. A directory where the file belongs makes the read
    // throw rather than merely produce nonsense.
    fs.mkdirSync(join(root, ".story", "servers", String(process.pid)), { recursive: true });
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers)
      .toEqual([{ pid: process.pid, identity: null, registeredAt: null }]);
  });

  it("ignores non-pid filenames rather than choking on them", () => {
    fs.mkdirSync(join(root, ".story", "servers"), { recursive: true });
    fs.writeFileSync(join(root, ".story", "servers", "not-a-pid"), "x");
    registerMcpServer(root, OWNER, process.pid);
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers.map((s) => s.pid)).toEqual([process.pid]);
  });

  it("a LEGACY bare-timestamp entry reads as identity-null, keeping its time", () => {
    // v1 entries are expected during rollout. They are unattributable, which is
    // the `undetermined` arm, not a reason to drop them from the listing.
    fs.mkdirSync(join(root, ".story", "servers"), { recursive: true });
    fs.writeFileSync(join(root, ".story", "servers", String(process.pid)), REGISTERED_AT);
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers[0])
      .toEqual({ pid: process.pid, identity: null, registeredAt: REGISTERED_AT });
  });

  it.each([
    ["unparseable garbage", "not-a-date"],
    ["truncated JSON", '{"v":2,"identity":{"client":"cla'],
    ["JSON with no identity field", '{"v":2,"registeredAt":"' + REGISTERED_AT + '"}'],
    ["an identity missing its id", '{"v":2,"identity":{"client":"claude"},"registeredAt":null}'],
    ["an identity with an unknown client", '{"v":2,"identity":{"client":"emacs","id":"x"},"registeredAt":null}'],
    ["an identity with an empty id", '{"v":2,"identity":{"client":"claude","id":""},"registeredAt":null}'],
    // A noncanonical id can never equal a normalized owner id, so it can never
    // MATCH. Accepting it anyway would still be wrong, and in the fail-OPEN
    // direction: it would count as a readable "known stranger" and let the
    // verdict skip the `successor-identity-unknown` arm an unattributable
    // server belongs in. Rejecting it to identity-null puts it in that arm,
    // which withholds the offer.
    ["an id with a space", '{"v":2,"identity":{"client":"claude","id":"has space"},"registeredAt":null}'],
    ["an id starting with punctuation", '{"v":2,"identity":{"client":"claude","id":".leading"},"registeredAt":null}'],
    ["an over-long id", `{"v":2,"identity":{"client":"claude","id":"${"x".repeat(129)}"},"registeredAt":null}`],
    ["a non-string id", '{"v":2,"identity":{"client":"claude","id":42},"registeredAt":null}'],
    // A future version may mean something else by these field names. Reading it
    // as v2 would attribute a server on a guess.
    ["a FUTURE entry version", '{"v":3,"identity":{"client":"claude","id":"owner-task-aaa"},"registeredAt":null}'],
    ["no entry version at all", '{"identity":{"client":"claude","id":"owner-task-aaa"},"registeredAt":null}'],
  ])("an entry with %s still reports the pid, with a NULL identity", (_label, raw) => {
    // A half-formed identity is worse than none: a partial match could suppress
    // a real recovery and a partial mismatch could authorize one, so anything
    // not fully formed degrades to null and lands in `undetermined`.
    fs.mkdirSync(join(root, ".story", "servers"), { recursive: true });
    fs.writeFileSync(join(root, ".story", "servers", String(process.pid)), raw);
    const seen = liveMcpServers(root);
    const entry = seen.kind === "observed" ? seen.servers[0] : undefined;
    expect(entry?.pid).toBe(process.pid);
    expect(entry?.identity ?? null).toBeNull();
  });

  it("a silent write is NOT a successful registration, identity or not", () => {
    // Ruling C-2 item 4. A symlink to /dev/null accepts every write and keeps
    // nothing, which is the shape a full disk or a lying filesystem produces.
    //
    // Both cases matter, and the identity-null one is the trap: it is what a
    // Codex server registers with at startup, and a read-back that is empty or
    // garbage parses to identity-null too. Verifying by parsed identity would
    // therefore compare null against null and call a registration a success
    // when the v2 payload never landed. What other readers then find is not
    // nothing: the pid-named entry is there and parses as unattributable, so
    // the server is present but unattributable for its whole life while the
    // binder believes it is properly registered.
    const dir = join(root, ".story", "servers");
    fs.mkdirSync(dir, { recursive: true });
    const entry = join(dir, String(process.pid));
    fs.rmSync(entry, { force: true });
    fs.symlinkSync("/dev/null", entry);
    try {
      expect(registerMcpServer(root, OWNER)).toBe(false);
      expect(registerMcpServer(root, null)).toBe(false);
    } finally {
      fs.rmSync(entry, { force: true });
      clearSelfVouch(root);
    }
  });

  it("registration failure is non-fatal", () => {
    // An unwritable root must degrade to `unavailable`, never throw: the MCP
    // server has to keep serving even with no registry.
    expect(() => registerMcpServer("/proc/nonexistent-storybloq-root", OWNER)).not.toThrow();
    expect(() => unregisterMcpServer("/proc/nonexistent-storybloq-root")).not.toThrow();
    clearSelfVouch("/proc/nonexistent-storybloq-root");
  });

  it("unregistering reports whether the entry is actually GONE", () => {
    // The caller keeps a root on its cleanup list until this says true, so the
    // distinction it draws is the whole point: "not there" covers unlinked and
    // already-absent alike, while anything else means the file may still be
    // sitting there carrying a live pid.
    expect(unregisterMcpServer(root)).toBe(true);       // nothing to remove

    // A path that cannot HOLD the entry proves absence just as well: a regular
    // file where the registry directory belongs yields ENOTDIR, and no file can
    // exist beneath it. Reporting failure there would keep the binder retrying
    // a cleanup that is already complete, forever.
    const notADir = join(root, "blocked");
    fs.writeFileSync(notADir, "not a directory");
    expect(unregisterMcpServer(notADir)).toBe(true);
    clearSelfVouch(notADir);

    registerMcpServer(root, OWNER);
    expect(unregisterMcpServer(root)).toBe(true);       // removed
    expect(unregisterMcpServer(root)).toBe(true);       // idempotent

    registerMcpServer(root, OWNER);
    const dirPath = join(root, ".story", "servers");
    fs.chmodSync(dirPath, 0o500);                       // readable, not writable
    try {
      expect(unregisterMcpServer(root)).toBe(false);
      expect(fs.existsSync(join(dirPath, String(process.pid)))).toBe(true);
    } finally { fs.chmodSync(dirPath, 0o700); }
  });
});

/**
 * Registration is VERIFIED, not best-effort (ruling C-2 item 4).
 *
 * A silent write failure leaves a live server that readers of the registry
 * cannot attribute: missing from the listing when nothing landed, or present
 * and unattributable when something wrong landed. The two fail in opposite
 * directions, which is why both matter. Missing is the state in which a
 * restarted owner's own client cannot be found, so a live owner reads as a
 * recovery candidate. Unattributable resolves to `undetermined`, withholding an
 * offer that may be entirely legitimate. Verification proves the exact payload
 * is on disk, which is what stands between an unproven initial bind and a
 * server that serves its whole life on neither; later damage is the guide-call
 * seam's job, covered separately below.
 */
describe("T-450: registration is verified, not assumed", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-verify-")); });
  afterEach(() => {
    clearSelfVouch(root);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("a write that lands correctly reports success", () => {
    expect(registerMcpServer(root, OWNER)).toBe(true);
  });

  it("registering with NO identity still verifies, and succeeds", () => {
    // A Codex server's startup shape. If the read-back comparison treated a
    // null round trip as a mismatch, every Codex server would decline the
    // registered role and retry forever.
    expect(registerMcpServer(root, null)).toBe(true);
  });

  it("a write that reports success but does NOT land reports failure", () => {
    // The shape a full disk, a racing writer, or a lying filesystem produces:
    // `writeFileSync` returns without error and the bytes are not there. A
    // symlink to /dev/null reproduces it exactly, and deterministically: the
    // write succeeds, and the read-back finds nothing to attribute.
    const dirPath = join(root, ".story", "servers");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.symlinkSync("/dev/null", join(dirPath, String(process.pid)));
    expect(registerMcpServer(root, OWNER)).toBe(false);
  });

  it("an identity the READER would reject is written as null, not looped on", () => {
    // Registration normalizes through the same gate `parseEntry` applies.
    // Without that, an id the reader rejects produces a registration that can
    // never verify: the read-back parses it to null, the comparison fails, the
    // binder declines the role and retries, and the retry writes the same
    // rejected value again, forever. Null is the honest answer instead: an
    // identity we cannot express is one we cannot claim.
    expect(registerMcpServer(root, { client: "claude", id: "has space", boundAt: STALE })).toBe(true);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toBeNull();
  });

  it("and re-assert treats one the same way, rather than rewriting every call", () => {
    const bad = { client: "claude", id: "has space", boundAt: STALE } as const;
    registerMcpServer(root, bad);
    const entryPath = join(root, ".story", "servers", String(process.pid));
    // A distinctive stored value, for the same reason as the no-op test above:
    // comparing what `register` wrote against what a rewrite would write passes
    // either way inside a single millisecond, because both stamp the clock.
    const marker = JSON.stringify({ v: 2, identity: null, registeredAt: "1999-12-31T23:59:59.000Z" });
    fs.writeFileSync(entryPath, marker);
    expect(reassertMcpServerIdentity(root, bad)).toBe(true);
    expect(fs.readFileSync(entryPath, "utf-8")).toBe(marker);
  });

  it("a write into a path that cannot be created reports failure", () => {
    const readOnly = join(root, "ro");
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o500);
    const unwritable = join(readOnly, "project");
    try {
      expect(registerMcpServer(unwritable, OWNER)).toBe(false);
    } finally {
      clearSelfVouch(unwritable);
      fs.chmodSync(readOnly, 0o700);
    }
  });

  it("a failed write still leaves this process VOUCHING for itself", () => {
    // Item 3 forbids self-suppression, and a failed registration is exactly the
    // moment it would happen: we are live and serving, and our own view of the
    // registry must not lose us because our own write failed.
    expect(registerMcpServer("/proc/nonexistent-storybloq-root", OWNER)).toBe(false);
    try {
      expect(selfVouch("/proc/nonexistent-storybloq-root")?.identity).toEqual(OWNER);
    } finally { clearSelfVouch("/proc/nonexistent-storybloq-root"); }
  });
});

/**
 * The guide-call seam (ruling C-2 item 1).
 *
 * `setup-skill` injects only `STORYBLOQ_CLIENT=codex` into a Codex server's
 * environment, so a Codex server registers identity-null at startup and can
 * learn its task id no other way than from a call carrying `clientTaskId`.
 */
describe("T-450: identity is re-asserted at the guide-call seam", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-reassert-")); });
  afterEach(() => {
    clearSelfVouch(root);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("upgrades an identity-null entry once a task id arrives", () => {
    registerMcpServer(root, null);
    expect(reassertMcpServerIdentity(root, OWNER)).toBe(true);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
  });

  it.each([
    ["DELETED", (p: string) => fs.unlinkSync(p)],
    ["CORRUPTED", (p: string) => fs.writeFileSync(p, "garbage")],
    ["replaced by a stranger's identity", (p: string) =>
      fs.writeFileSync(p, JSON.stringify({ v: 2, identity: OTHER, registeredAt: REGISTERED_AT }))],
  ])("repairs an entry %s underneath a running server", (_label, damage) => {
    // A stray cleanup, a reaper that raced a pid probe, an operator with rm.
    // Without the seam this server stays unattributable, or gone from the
    // listing entirely, until it restarts. The three cases differ in what a
    // reader sees, and none of them is a server readers can match to its owner:
    // deleted is absent, garbage parses to identity-null, and a stranger's
    // identity is a positive claim that we are somebody else.
    //
    // The VOUCH IS LEFT INTACT on purpose, and it is the whole test. An
    // implementation that stops at "our memory already says OWNER" returns
    // early and repairs nothing, which is exactly the defect this found: our
    // own memory being right is no comfort to the process reading the file.
    registerMcpServer(root, OWNER);
    const entryPath = join(root, ".story", "servers", String(process.pid));
    damage(entryPath);
    expect(selfVouch(root)?.identity).toEqual(OWNER);

    expect(reassertMcpServerIdentity(root, OWNER)).toBe(true);

    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
  });

  it("is a no-op when the identity has not changed", () => {
    registerMcpServer(root, OWNER);
    const entryPath = join(root, ".story", "servers", String(process.pid));
    // A distinctive on-disk value a rewrite could not reproduce. Comparing the
    // bytes register() wrote against the bytes a rewrite would write is not
    // enough: both stamp `registeredAt` from the clock, and inside one
    // millisecond they are identical, so the assertion would pass either way.
    const marker = JSON.stringify({ v: 2, identity: OWNER, registeredAt: "1999-12-31T23:59:59.000Z" });
    fs.writeFileSync(entryPath, marker);
    expect(reassertMcpServerIdentity(root, OWNER)).toBe(true);
    expect(fs.readFileSync(entryPath, "utf-8")).toBe(marker);
  });

  it("re-asserts when only the CLIENT differs, not just the id", () => {
    // Task ids are per-client namespaces, so `claude/x` and `codex/x` are
    // different tasks. Comparing ids alone would treat this as unchanged and
    // leave the entry claiming the wrong client forever.
    registerMcpServer(root, OWNER);
    expect(reassertMcpServerIdentity(root, OWNER_ID_OTHER_CLIENT)).toBe(true);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER_ID_OTHER_CLIENT);
  });

  it("a null identity never DOWNGRADES an entry that already has one", () => {
    // Guide calls arrive with and without `clientTaskId`. One without must not
    // erase what an earlier one established, or the entry would flap between
    // attributable and unattributable and the verdict with it.
    registerMcpServer(root, OWNER);
    expect(reassertMcpServerIdentity(root, null)).toBe(true);
    expect(selfVouch(root)?.identity).toEqual(OWNER);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
  });

  it("switches identity when the task genuinely changes", () => {
    registerMcpServer(root, OWNER);
    expect(reassertMcpServerIdentity(root, OTHER)).toBe(true);
    clearSelfVouch(root);
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OTHER);
  });
});

/**
 * The evaluator vouches for its OWN entry (ruling C-2 item 3).
 *
 * Self-suppression is a process declaring the registry unusable, or its own
 * entry unattributable, because of its own write, and thereby refusing to offer
 * a recovery that it is the one running. The tests here pin that it does not
 * happen, along with the boundaries of the vouch: which registries it does not
 * rescue, when it is dropped, and that it never crosses roots.
 *
 * The scope is exactly that: our own entry, in an enumeration that SUCCEEDED.
 * The permanent-failure test at the end pins the other side, where the registry
 * cannot be enumerated at all and suppression is the answer for every reader
 * with the same access. The transient case next to it is not that: it uses a
 * healthy registry that our own entry is simply missing from.
 */
describe("T-450: this process does not suppress on its OWN entry", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-vouch-")); });
  afterEach(() => {
    clearSelfVouch(root);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("an ABSENT registry directory is unavailable even while we hold a vouch", () => {
    // THE LIMIT OF THE VOUCH. It proves what we contribute; it proves nothing
    // about who else is missing. A directory that does not exist means NOBODY
    // registered successfully, and if the owner's server failed for the same
    // reason ours did, answering "enumerated, and the only server running is
    // me" would authorize recovery against a live owner.
    expect(liveMcpServers(root).kind).toBe("unavailable");
    registerMcpServer(root, OWNER);
    rmSync(join(root, ".story"), { recursive: true, force: true });
    expect(selfVouch(root)?.identity).toEqual(OWNER);
    expect(liveMcpServers(root).kind).toBe("unavailable");
  });

  it("our entry MISSING from a healthy listing is replaced by the vouch", () => {
    registerMcpServer(root, OWNER);
    fs.unlinkSync(join(root, ".story", "servers", String(process.pid)));
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
  });

  it("our entry CORRUPTED on disk reads as ours, not as unattributable", () => {
    // The one that would otherwise turn our own bad file into
    // `successor-identity-unknown` and suppress a verdict about somebody else.
    registerMcpServer(root, OWNER);
    fs.writeFileSync(join(root, ".story", "servers", String(process.pid)), "garbage");
    const seen = liveMcpServers(root);
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
  });

  it("the vouch does not survive unregistration", () => {
    registerMcpServer(root, OWNER);
    expect(unregisterMcpServer(root)).toBe(true);
    expect(selfVouch(root)).toBeUndefined();
    // And a released server stops appearing in the listing it used to be in.
    const seen = liveMcpServers(root);
    expect(seen.kind === "observed" && seen.servers.some((s) => s.pid === process.pid)).toBe(false);
  });

  it("a vouch for one root says nothing about another", () => {
    const other = mkdtempSync(join(tmpdir(), "t450-vouch-b-"));
    try {
      registerMcpServer(root, OWNER);
      expect(liveMcpServers(other).kind).toBe("unavailable");
    } finally {
      clearSelfVouch(other);
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("end to end: our own unlisted entry does not block OUR offer", () => {
    // The full path, not just the listing, and the shape the vouch is actually
    // FOR: the directory enumerates fine, and the only thing missing from it is
    // us. Before the corrective this read `undetermined`, which was this
    // process refusing to offer a recovery it is the one running.
    registerMcpServer(root, OTHER);
    fs.unlinkSync(join(root, ".story", "servers", String(process.pid)));
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => liveMcpServers(root));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
  });

  /**
   * The honest limit of the vouch, pinned so nobody later reads the tests above
   * and widens it into a fail-open.
   *
   * The vouch fixes OUR contribution to an enumeration that HAPPENED. It cannot
   * stand in for an enumeration that did not: a directory this process cannot
   * read, or that does not exist, may be hiding the owner's own server, which is
   * the entry that would suppress. Answering "enumerated, and the only server
   * running is me" there is a claim about every other process made on evidence
   * about one.
   */
  it.each([
    ["UNREADABLE", (dirPath: string) => fs.chmodSync(dirPath, 0o000)],
    ["ABSENT", (dirPath: string) => rmSync(dirPath, { recursive: true, force: true })],
  ])("a vouch does not substitute for a registry that is %s", (_label, breakIt) => {
    registerMcpServer(root, OWNER);
    const dirPath = join(root, ".story", "servers");
    breakIt(dirPath);
    try {
      expect(selfVouch(root)).toBeDefined();
      expect(liveMcpServers(root).kind).toBe("unavailable");
    } finally { try { fs.chmodSync(dirPath, 0o700); } catch { /* already removed */ } }
  });

  it("and that limit holds end to end: no offer from an unenumerable registry", () => {
    // The counterpart to the test above. Same evaluator, same evidence, and the
    // only difference is whether the directory could be read at all.
    registerMcpServer(root, OTHER);
    rmSync(join(root, ".story", "servers"), { recursive: true, force: true });
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => liveMcpServers(root));
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });
});

describe("T-450: the RAPID restart, which no temporal anchor gets right", () => {
  /**
   * The sequence that falsified the marker-anchored form, kept because it is
   * still the sequence the predicate has to survive. The replacement server
   * registers the instant the client reconnects; the OLD sidecar only notices
   * reparenting on its next tick, up to 10s later. So the true successor
   * legitimately registered BEFORE the marker it supersedes, and an anchor on
   * marker time reads a live owner mid-IMPLEMENT as `gone-candidate`.
   *
   * Anchoring on the recorded server's last guide call instead fails the other
   * way, and worse: every fresh client registers after it, so the recovery
   * client superseded itself and the offer could never fire. Identity is
   * indifferent to both, which is the whole point of ruling C-2.
   */
  it("the true successor suppresses even though it predates the marker", () => {
    writeShutdown();
    const predatesMarker = new Date(MARKER_AT - 10_000).toISOString();
    expect(new Date(predatesMarker).getTime()).toBeLessThan(MARKER_AT);
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir,
      () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, identity: OWNER, registeredAt: predatesMarker }] }),
    );
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it("a recorded pid with NO paired timestamp is placed by identity anyway", () => {
    // `mcpGuideCallAt` was the succession anchor, so its absence used to
    // suppress. It is display-only now, and the identity question is answerable
    // without it.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid() }), NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [] }),
    );
    expect(v.kind).toBe("gone-candidate");
    expect(v.signals.markerValidity.kind === "not-invalidated"
      && v.signals.markerValidity.recordedAt).toBeNull();
  });

  it("the paired timestamp is still carried into the evidence as recordedAt", () => {
    // Display and audit: the confirmation prompt wants to say when the recorded
    // server was last serving. The liveness PREDICATE no longer acts on it; the
    // stored value still travels in the evidence, and through it into the
    // fingerprint, which is what keeps a confirmation honest about what was
    // shown.
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
        : { kind: "observed" as const, servers: [server(process.pid, OWNER)] };
    };
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
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
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }),
    );
    expect(v.kind).toBe("gone-candidate");
  });
});

describe("T-450: a failed registration is not recorded as a successful bind", () => {
  it("registerMcpServer reports failure rather than swallowing it", () => {
    expect(registerMcpServer("/proc/nonexistent-storybloq-root", OWNER)).toBe(false);
    clearSelfVouch("/proc/nonexistent-storybloq-root");
  });

  it("registerMcpServer reports success on a writable root", () => {
    const root = mkdtempSync(join(tmpdir(), "t450-ok-"));
    try {
      expect(registerMcpServer(root, OWNER)).toBe(true);
      const seen = liveMcpServers(root);
      expect(seen.kind === "observed" && seen.servers.some((s) => s.pid === process.pid)).toBe(true);
    } finally { clearSelfVouch(root); rmSync(root, { recursive: true, force: true }); }
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
        : { kind: "observed" as const, servers: [server(process.pid, OWNER)] };
    };
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, provider,
    );
    expect(v.kind).toBe("contradicted");
    // The evidence must not still claim an empty registry while the verdict
    // blames a pid that only the second read saw.
    expect(v.signals.successors).toEqual({
      kind: "observed",
      servers: [server(process.pid, OWNER)],
    });
    expect(v.signals.markerValidity.kind === "invalidated"
      && v.signals.markerValidity.successorPids).toEqual([process.pid]);
  });
});

describe("T-450: a bad paired timestamp is cosmetic, not decisive", () => {
  const FUTURE_STAMP = new Date(NOW + 60 * 60_000).toISOString();
  it.each([
    // Unparseable is dropped, because there is nothing to display. Far-future
    // is carried: it is a real instant, it is simply an implausible one, and
    // the PREDICATE no longer acts on either. Both still travel in the
    // evidence, and through it into the fingerprint.
    ["unparseable", "not-a-date", null],
    ["far-future", FUTURE_STAMP, FUTURE_STAMP],
  ])("a %s mcpGuideCallAt neither authorizes nor suppresses", (_label, stamp, expected) => {
    // It used to do both, in opposite directions, because it was the succession
    // anchor: an unreadable one suppressed everything, and a future-dated one
    // made every genuine successor compare as older, which was fail-OPEN. The
    // verdict now comes from identity and the marker, exactly as it would with
    // no timestamp at all.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: stamp }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }),
    );
    expect(v.kind).toBe("gone-candidate");
    expect(v.signals.markerValidity.kind === "not-invalidated"
      && v.signals.markerValidity.recordedAt).toBe(expected);
  });

  it("and it cannot rescue a verdict the identity arm suppresses", () => {
    // The other half of "cosmetic": a perfectly good timestamp does not make an
    // unattributable successor attributable.
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [server(process.pid, null)] }),
    );
    expect(v.kind).toBe("undetermined");
    expect(permitsRecoveryOffer(v)).toBe(false);
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

/**
 * What replaced the self-suppression mechanism.
 *
 * A process that failed to register used to flag the whole registry
 * `unavailable` FOR ITSELF, so its own evaluations could never authorize
 * anything. Ruling C-2 item 3 forbids that: the failure being ours is the one
 * case we have direct knowledge of, and refusing to offer a recovery on the
 * strength of our own write is the least justified suppression available.
 *
 * The genuine exposure it was aiming at is unchanged and is covered by the
 * binder tests below, and it FAILS OPEN: a third process cannot see an
 * unregistered server, so it cannot match that server's identity against a
 * session's owner, and an absent entry is not an ambiguity signal. Nothing
 * distinguishes "the owner's server is missing from this listing" from "the
 * owner's client is not running", so a third evaluator can reach
 * `gone-candidate` against a live owner until the retry lands. That interval is
 * what the fast first retry bounds; it is not closed.
 */
describe("T-450: a process-local missing entry does not suppress its own process", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t450-unreg-")); });
  afterEach(() => {
    clearSelfVouch(root);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("registration REPORTS its failure rather than suppressing on it", () => {
    // Where the signal goes. The return value is the report, and the binder
    // acting on it is pinned in the binder suite below; what matters here is
    // that a failure is surfaced to the caller instead of being turned into a
    // process-local reason to go quiet. A failure for one root also says
    // nothing about another, so the second call must still succeed.
    const blocked = join(root, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    try {
      expect(registerMcpServer(blocked, OWNER)).toBe(false);
      expect(registerMcpServer(root, OWNER)).toBe(true);
    } finally { clearSelfVouch(blocked); }
  });

  it("declining the registered ROLE is what a failed bind actually does", () => {
    // The remaining protection, and a real one: an unregistered server stamps
    // no pid, so a session it serves reads `no-recorded-pid` and suppresses.
    // That is scoped to the sessions it touches, not to everything it reads.
    __testing.setProcessRole("mcp-unregistered");
    try {
      expect(currentMcpServerPid()).toBeNull();
    } finally { __testing.setProcessRole("cli"); }
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
        ? { ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }
        : { ownerTask: OWNER, lastGuideCall: FRESH, mcpServerPid: deadPid(), mcpGuideCallAt: STALE };
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
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => ({ kind: "observed", servers: [] }));
    expect(v.kind).toBe("gone-candidate");
  });
});

/**
 * The clock cannot reach this predicate at all any more.
 *
 * The previous design needed a skew tolerance because a backward clock
 * adjustment between the predecessor's guide call and the successor's
 * registration gave the genuine successor an earlier timestamp, and strict
 * ordering would then authorize against a live owner. Tolerance in turn widened
 * the window in which an unrelated server counted. Identity has no such dial,
 * and these pin that the dial is really gone rather than merely unused.
 */
describe("T-450: no clock reading can change a succession verdict", () => {
  it.each([
    ["decades ago", new Date(NOW - 30 * 365 * 24 * 3_600_000).toISOString()],
    ["a moment ago", new Date(NOW - 1_000).toISOString()],
    ["far in the future", new Date(NOW + 30 * 365 * 24 * 3_600_000).toISOString()],
    ["unreadable", null],
  ])("the owner's live server supersedes when it registered %s", (_label, registeredAt) => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, identity: OWNER, registeredAt }] }));
    expect(v.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(v)).toBe(false);
  });

  it.each([
    ["decades ago", new Date(NOW - 30 * 365 * 24 * 3_600_000).toISOString()],
    ["a moment ago", new Date(NOW - 1_000).toISOString()],
    ["far in the future", new Date(NOW + 30 * 365 * 24 * 3_600_000).toISOString()],
    ["unreadable", null],
  ])("a stranger's live server supersedes nothing when it registered %s", (_label, registeredAt) => {
    writeShutdown();
    writeSidecarPid(deadPid());
    const v = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS,
      () => ({ kind: "observed", servers: [{ pid: process.pid, identity: OTHER, registeredAt }] }));
    expect(v.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(v)).toBe(true);
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
        ? { ownerTask: OWNER, lastGuideCall: FRESH, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }
        : { ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE };
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
        ? { ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }
        : { ownerTask: OWNER, lastGuideCall: value, mcpServerPid: deadPid(), mcpGuideCallAt: STALE };
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
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: undefined, mcpGuideCallAt: undefined }),
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
    clearSelfVouch(root);
    clearSelfVouch(join(root, "blocked"));
    __testing.setProcessRole("cli");
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /**
   * The sequence clearing alone does NOT cover: predecessor A leaves a stale
   * session carrying its pair, A dies, replacement B fails to register, and
   * the owner keeps working without another guide call, so B never touches
   * that session. Two independent mechanisms have to close it, because
   * clearing needs a refresh that never comes.
   *
   * The two differ in who is affected, which is worth keeping straight. The
   * PERMANENT case suppresses for every reader whose access cannot enumerate or
   * write the registry, the vouching process included: it is a fact about the
   * directory, not a blind spot one process talked itself into. The TRANSIENT
   * case is the third-party one: the registry enumerates fine, so the process
   * that failed substitutes its own entry and sees itself, while everyone else
   * enumerating it sees a listing it is simply missing from.
   */
  it("PERMANENT failure: a vouch does not exempt this reader from an unwritable registry", () => {
    const dirPath = join(root, ".story", "servers");
    fs.mkdirSync(dirPath, { recursive: true });
    // Register FIRST, so this process genuinely holds a vouch when the registry
    // goes bad. Without it the test would prove only that a vouchless reader
    // suppresses, which is not the claim: the claim is that holding a vouch
    // does not buy an exemption from a registry-wide failure. 0o500 leaves the
    // directory readable, so enumeration succeeds and the WRITABILITY probe is
    // what fails.
    expect(registerMcpServer(root, OWNER)).toBe(true);
    expect(selfVouch(root)).toBeDefined();
    fs.chmodSync(dirPath, 0o500);
    try {
      // No process-local flag involved: this process holds a vouch and is
      // suppressed anyway. The answer does not depend on who is asking, only on
      // what the directory permits the reader doing the asking.
      const seen = liveMcpServers(root);
      expect(seen.kind).toBe("unavailable");

      writeShutdown();
      writeSidecarPid(deadPid());
      const v = readOwnerLiveness(
        dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
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
    expect(registerMcpServer(blocked, OWNER)).toBe(false);
    // `unavailable` with or without a vouch, and that is the point: the path is
    // a regular file, so no reader can enumerate it, and a vouch speaks only to
    // our own entry within an enumeration that succeeded.
    expect(liveMcpServers(blocked).kind).toBe("unavailable");
    clearSelfVouch(blocked);
    expect(liveMcpServers(blocked).kind).toBe("unavailable");

    // The path becomes usable; the retry path is just another call.
    fs.unlinkSync(blocked);
    expect(registerMcpServer(blocked, OWNER)).toBe(true);
    clearSelfVouch(blocked);
    const seen = liveMcpServers(blocked);
    expect(seen.kind).toBe("observed");
    const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
    expect(mine && mine.identity).toEqual(OWNER);
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
      /**
       * Fire a specific live timer. Needed once two independent slots can be
       * armed at the same time (registration repair and cleanup), because
       * `fire` takes the most recent and a real clock does not.
       */
      fireLive(index: number) {
        const t = timers.filter((x) => !x.cancelled && !x.fired)[index];
        if (!t) throw new Error(`no live timer at index ${index}`);
        t.fired = true;
        t.fn();
      },
    };
  }

  /** Records exit wiring instead of attaching listeners to the real process. */
  let exitReleases: Array<() => void>;

  function binderWith(
    sched: ReturnType<typeof fakeScheduler>,
    identity: OwnerTask | null = OTHER,
  ) {
    return new ServerRegistryBinder({
      register: registerMcpServer,
      unregister: unregisterMcpServer,
      // The binder reads its identity from the spawn environment. Injecting it
      // keeps these tests off `process.env`, which a parallel worker shares.
      identity: () => identity,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet in tests */ },
    });
  }

  /**
   * Evaluate the way a third process with the same access would: no in-process
   * vouch for this root. It runs under this pid and these permissions, so it
   * simulates that reader rather than being one; the vouch is the only thing
   * that differs, and it is the only thing that matters here.
   *
   * That asymmetry IS the residual window. Once the registry enumerates, the
   * process whose registration failed substitutes its own entry and sees itself
   * (ruling C-2 item 3); a third process has only the registry, and between the
   * cause clearing and the retry landing there is nothing in it. Dropping the
   * vouch is the whole point of the helper, not a shortcut around one.
   */
  function evaluateAsThirdParty(registryRoot: string) {
    clearSelfVouch(registryRoot);
    return readOwnerLiveness(
      dir,
      () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
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
    clearSelfVouch(blocked);
    clearSelfVouch(root);
    clearSelfVouch(join(root, "a"));
    clearSelfVouch(join(root, "b"));
    clearSelfVouch(join(root, "a2"));
    clearSelfVouch(join(root, "b2"));
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

  it("a failed bind declines the registered ROLE but keeps vouching for itself", () => {
    const sched = fakeScheduler();
    const binder = binderWith(sched);
    binder.bind(blocked);

    expect(binder.root).toBeNull();
    expect(binder.retrying).toBe(true);
    // Not registered, so it stamps no pid: a session it serves carries no
    // recorded pid, which reads as `no-recorded-pid` and suppresses. That is
    // scoped to sessions this server touches, which is the honest scope.
    expect(mcpProcessRole()).toBe("mcp-unregistered");
    expect(currentMcpServerPid()).toBeNull();
    // And it still knows it is alive here, which item 3 requires.
    expect(selfVouch(blocked)?.identity).toEqual(OTHER);
  });

  it("a recovery client whose own registration failed still offers", () => {
    // The inversion ruling C-2 item 3 required. A server that failed to
    // register used to flag the registry unavailable for its own reads, so
    // nothing it evaluated could authorize anything, even when the registry was
    // perfectly readable and the only thing missing from it was us. It was the
    // least justified suppression available: the one server whose absence from
    // the listing we can positively explain is our own.
    //
    // The binder here vouches as OTHER, the recovery client, against a session
    // owned by OWNER. That is the case the offer exists for. A process vouching
    // as OWNER would suppress, and correctly so: it would be the owner's own
    // client proving it is alive.
    const sched = fakeScheduler();
    binderWith(sched).bind(blocked);
    expect(mcpProcessRole()).toBe("mcp-unregistered");

    // The transient cause clears and a registry left by an earlier server is
    // readable, writable and empty. Our retry has not run, so the enumeration
    // succeeds and we are the one entry missing from it.
    fs.unlinkSync(blocked);
    fs.mkdirSync(join(blocked, ".story", "servers"), { recursive: true });

    writeShutdown();
    writeSidecarPid(deadPid());
    const own = readOwnerLiveness(
      dir, () => ({ ownerTask: OWNER, lastGuideCall: STALE, mcpServerPid: deadPid(), mcpGuideCallAt: STALE }),
      NOW, OWNER_STALE_MS, () => liveMcpServers(blocked));
    expect(own.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(own)).toBe(true);
  });

  it("the window is BOUNDED, not closed: a third evaluator can reach a candidate until the retry lands", () => {
    // The honest statement of the residual. The vouch cannot reach another
    // process; only the registry entry can, and between the cause clearing and
    // the retry landing there is no entry. So a third evaluator cannot find the
    // owner's client and reads a live owner as a candidate.
    //
    // The binder registers as the OWNER here: that is what makes the entry the
    // one that suppresses once it lands.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    binder.bind(blocked);

    writeShutdown();
    writeSidecarPid(deadPid());

    // The transient cause clears, and a registry left behind by an earlier
    // server is readable, writable and empty. The binder's retry has not run.
    fs.unlinkSync(blocked);
    fs.mkdirSync(join(blocked, ".story", "servers"), { recursive: true });

    const duringWindow = evaluateAsThirdParty(blocked);
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
    const landed = registered.kind === "observed" && registered.servers.find((s) => s.pid === process.pid);
    // The identity is what closes the window, not the entry's mere existence.
    expect(landed && landed.identity).toEqual(OWNER);

    // Same evaluator, same evidence, and now suppressed: the owner's client is
    // demonstrably alive somewhere other than the dead recorded server.
    const afterRetry = evaluateAsThirdParty(blocked);
    expect(afterRetry.kind).toBe("contradicted");
    expect(permitsRecoveryOffer(afterRetry)).toBe(false);
  });

  it("a bind that registers a STRANGER does not close a third evaluator's window", () => {
    // The bound is on the OWNER's server reappearing. Any other client's server
    // coming up says nothing, and the previous design would have counted it.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OTHER);
    binder.bind(blocked);
    writeShutdown();
    writeSidecarPid(deadPid());

    fs.unlinkSync(blocked);
    fs.mkdirSync(join(blocked, ".story", "servers"), { recursive: true });
    sched.fire();
    expect(binder.root).toBe(blocked);

    const afterRetry = evaluateAsThirdParty(blocked);
    expect(afterRetry.kind).toBe("gone-candidate");
    expect(permitsRecoveryOffer(afterRetry)).toBe(true);
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
    const binder = new ServerRegistryBinder({
      register: () => { throw new Error("registry exploded"); },
      unregister: () => true,
      identity: () => OTHER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    expect(() => binder.bind(root)).not.toThrow();
    expect(binder.root).toBeNull();
    expect(binder.retrying).toBe(true);
    expect(mcpProcessRole()).toBe("mcp-unregistered");
  });

  it("an identity provider that THROWS is failure, not an identity-null bind", () => {
    // Registering identity-null when the environment IS readable would plant an
    // unattributable entry that drags every evaluator who enumerates it into
    // `undetermined`.
    // Better to fail and retry than to publish a lie about who we are.
    const sched = fakeScheduler();
    let registered = 0;
    const binder = new ServerRegistryBinder({
      register: () => { registered += 1; return true; },
      unregister: () => true,
      identity: () => { throw new Error("env exploded"); },
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    expect(() => binder.bind(root)).not.toThrow();
    expect(registered).toBe(0);
    expect(binder.root).toBeNull();
    expect(binder.retrying).toBe(true);
    expect(mcpProcessRole()).toBe("mcp-unregistered");
  });

  /**
   * The other end of verified registration.
   *
   * A bind that succeeded is not a registration that STAYS. The guide-call
   * re-assert verifies against the file, so it can discover that an established
   * entry has since been deleted or corrupted. If that discovery goes nowhere,
   * the process stays marked registered and keeps stamping its pid onto every
   * session it serves on an entry no reader can corroborate,
   * which is the state ruling C-2 item 4 exists to prevent, reached from the
   * other direction.
   */
  it("a registration lost AFTER a successful bind demotes and retries", () => {
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const usable = join(root, "usable");
    fs.mkdirSync(usable, { recursive: true });
    try {
      binder.bind(usable);
      expect(binder.root).toBe(usable);
      expect(mcpProcessRole()).toBe("mcp-registered");
      expect(sched.live()).toHaveLength(0);

      binder.registrationLost(usable);

      expect(binder.root).toBeNull();
      expect(mcpProcessRole()).toBe("mcp-unregistered");
      // Not registered means it stamps no pid, so sessions it serves from here
      // read `no-recorded-pid` instead of naming a server whose registration
      // cannot be corroborated.
      expect(currentMcpServerPid()).toBeNull();
      expect(binder.retrying).toBe(true);
      expect(sched.timers[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);

      // And the retry restores it, rather than leaving the server demoted.
      sched.fire();
      expect(binder.root).toBe(usable);
      expect(mcpProcessRole()).toBe("mcp-registered");
    } finally {
      unregisterMcpServer(usable);
      clearSelfVouch(usable);
    }
  });

  it("a loss on the HELD root re-aims a retry armed for another one", () => {
    // The single retry slot is a starvation hazard. Bound to A, a failed bind
    // to B arms a B timer while A stays bound; A then losing verification could
    // never schedule its own repair, because the slot was occupied by a root we
    // are not even serving. The newest statement of intent takes the slot.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const rootA = join(root, "a3");
    fs.mkdirSync(rootA, { recursive: true });
    const rootB = join(root, "b3");   // a regular file: binding it fails
    fs.writeFileSync(rootB, "not a directory");
    try {
      binder.bind(rootA);
      expect(binder.root).toBe(rootA);

      binder.bind(rootB);
      expect(binder.root).toBe(rootA);      // the move did not happen
      expect(sched.live()).toHaveLength(1); // and a B retry is armed

      binder.registrationLost(rootA);
      expect(binder.root).toBeNull();
      // Exactly one live timer, and it is aimed at A: the B timer was cancelled
      // rather than left to win the slot.
      expect(sched.live()).toHaveLength(1);
      // And at the FAST first delay. `attempt` is one counter, so without a
      // reset A's repair inherits however far B had escalated, which is up to
      // 30 seconds. The fast first retry is what bounds the fail-open window,
      // so a fresh target serving somebody else's backoff defeats the bound.
      expect(sched.live()[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);
      sched.fire();
      expect(binder.root).toBe(rootA);
      expect(mcpProcessRole()).toBe("mcp-registered");

      // And B is not left holding anything. A failed registration can still
      // have written the file, because verification is a READ-BACK: the write
      // may have landed and only the proof failed. Cleaning up only the bound
      // root leaves a live pid in a project this process never served.
      expect(selfVouch(rootB)).toBeUndefined();
    } finally {
      unregisterMcpServer(rootA);
      clearSelfVouch(rootA);
      clearSelfVouch(rootB);
    }
  });

  it("a failed bind that DID write is cleaned up when we bind elsewhere", () => {
    // The leak in its literal form. B's write CALL succeeds while the payload
    // lands nowhere, so `register` reports failure through the read-back while
    // the pid-named entry exists carrying our live pid. Binding C must not
    // leave it there.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const rootB = join(root, "b6");
    const rootC = join(root, "c6");
    fs.mkdirSync(join(rootB, ".story", "servers"), { recursive: true });
    fs.mkdirSync(rootC, { recursive: true });
    const entryB = join(rootB, ".story", "servers", String(process.pid));
    fs.symlinkSync("/dev/null", entryB);
    try {
      binder.bind(rootB);
      expect(binder.root).toBeNull();      // verification failed
      expect(fs.existsSync(entryB)).toBe(true);

      binder.bind(rootC);
      expect(binder.root).toBe(rootC);
      expect(fs.existsSync(entryB)).toBe(false);
      expect(selfVouch(rootB)).toBeUndefined();
    } finally {
      unregisterMcpServer(rootB);
      unregisterMcpServer(rootC);
      clearSelfVouch(rootB);
      clearSelfVouch(rootC);
    }
  });

  it("a rebind after a lost registration still releases the abandoned root", () => {
    // `registrationLost` clears `boundRoot`, so a later bind sees no previous
    // root to release. Without remembering the abandoned one, a live pid keeps
    // an entry in a registry it no longer serves, and evaluators there read it
    // as a live server for as long as this process is alive, and longer still
    // under pid reuse or a probe that answers anything but ESRCH. Whether that
    // entry suppresses or merely confuses depends on whose identity it carries;
    // either way it is evidence about a project we walked away from.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const rootA = join(root, "a4");
    const rootB = join(root, "b4");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    try {
      binder.bind(rootA);
      expect(fs.existsSync(join(rootA, ".story", "servers", String(process.pid)))).toBe(true);
      binder.registrationLost(rootA);

      binder.bind(rootB);
      expect(binder.root).toBe(rootB);
      const a = liveMcpServers(rootA);
      expect(a.kind === "observed" && a.servers.some((s) => s.pid === process.pid)).toBe(false);
    } finally {
      unregisterMcpServer(rootA);
      unregisterMcpServer(rootB);
      clearSelfVouch(rootA);
      clearSelfVouch(rootB);
    }
  });

  it("shutdown after a lost registration still cleans up the entry", () => {
    // Left-behind files are self-healing in the ordinary case: the first
    // evaluator to enumerate probes the pid, gets ESRCH and reaps it. Cleaning
    // up eagerly still earns its keep, because until that enumeration happens
    // the file is one pid recycle away from reading as a live server that never
    // existed, and a probe that answers anything but ESRCH keeps it.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const rootA = join(root, "a5");
    fs.mkdirSync(rootA, { recursive: true });
    const entryA = join(rootA, ".story", "servers", String(process.pid));
    try {
      binder.bind(rootA);
      binder.registrationLost(rootA);
      expect(fs.existsSync(entryA)).toBe(true);

      exitReleases[0]?.();
      expect(fs.existsSync(entryA)).toBe(false);
      expect(sched.live()).toHaveLength(0);
    } finally {
      unregisterMcpServer(rootA);
      clearSelfVouch(rootA);
    }
  });

  it("a cleanup that FAILS keeps the root on the list for another attempt", () => {
    // The orphan hazard in its exact form. Unlinking can fail transiently
    // (EACCES on the directory, EIO), and the entry still carries a live pid.
    // Forgetting the root on a failed delete means nothing ever tries again,
    // and a project this process walked away from keeps a live server that is
    // not there.
    const sched = fakeScheduler();
    const attempts: string[] = [];
    let allowDelete = false;
    const binder = new ServerRegistryBinder({
      register: () => true,
      unregister: (r) => { attempts.push(r); return allowDelete; },
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    const rootA = join(root, "a8");
    const rootB = join(root, "b8");
    const rootC = join(root, "c8");

    binder.bind(rootA);
    binder.bind(rootB);
    expect(attempts).toEqual([rootA]);      // tried, and it failed

    binder.bind(rootC);
    // Tried AGAIN rather than forgotten. B is also due by now.
    expect(attempts.filter((r) => r === rootA).length).toBe(2);
    expect(attempts).toContain(rootB);

    allowDelete = true;
    binder.release();
    const beforeFinal = attempts.length;
    binder.release();
    // Once the deletes succeed the roots drop off, so a second release has
    // nothing left to attempt.
    expect(attempts.length).toBe(beforeFinal);
  });

  it("an abandoned entry is retried on a timer, not only on the next bind", () => {
    // The production shape, and the one bookkeeping alone does not cover: the
    // binder moves from A to B, A's unlink fails transiently, and then nothing
    // else happens. `bind(B)` returns early as a no-op, no release comes, and
    // without a timer of its own A keeps a live pid in its registry until this
    // process exits, which can be hours.
    const sched = fakeScheduler();
    const attempts: string[] = [];
    let allowDelete = false;
    const binder = new ServerRegistryBinder({
      register: () => true,
      unregister: (r) => { attempts.push(r); return allowDelete; },
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    const rootA = join(root, "a9");
    const rootB = join(root, "b9");

    binder.bind(rootA);
    binder.bind(rootB);
    expect(binder.root).toBe(rootB);
    expect(attempts).toEqual([rootA]);
    // Armed on its OWN slot, so it cannot starve, or be starved by, the
    // registration retry for the root we are actually serving.
    expect(binder.cleaningUp).toBe(true);
    expect(binder.retrying).toBe(false);
    expect(sched.live()[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);

    // Idle. No bind, no release: only the clock.
    sched.fire();
    expect(attempts).toEqual([rootA, rootA]);
    expect(binder.cleaningUp).toBe(true);
    // And it backs off rather than spinning.
    expect(sched.live()[0]?.ms).toBe(RETRY_BACKOFF_MS[1]);

    allowDelete = true;
    sched.fire();
    expect(attempts).toEqual([rootA, rootA, rootA]);
    // Cleaned up, so it disarms instead of ticking forever.
    expect(binder.cleaningUp).toBe(false);
    expect(sched.live()).toHaveLength(0);
    // And the root we serve was never a cleanup target.
    expect(binder.root).toBe(rootB);
    expect(attempts).not.toContain(rootB);
  });

  it("a registration repair arms alongside a cleanup already in flight", () => {
    // The two slots must be independent in BOTH directions. Cleanup is armed
    // first here, and a repair starting afterwards must neither cancel it nor
    // wait on it: they answer different questions, and making cleanup wait on
    // repair leaves a live pid in another project for as long as repair keeps
    // failing, which is exactly when it is least likely to be quick. The
    // opposite order is covered by the re-aim test below.
    const sched = fakeScheduler();
    let allowDelete = false;
    let canRegister = true;
    // Every root cleanup ACTUALLY aimed at, not just whether it re-armed. An
    // `unregister` that reports failure and records nothing lets a test pass
    // while the real one deletes an entry it was never supposed to touch.
    const deleted: string[] = [];
    const binder = new ServerRegistryBinder({
      register: () => canRegister,
      unregister: (r) => { deleted.push(r); return allowDelete; },
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    const rootA = join(root, "a10");
    const rootB = join(root, "b10");

    binder.bind(rootA);
    binder.bind(rootB);          // A's cleanup fails, so cleanup is armed
    expect(binder.cleaningUp).toBe(true);
    expect(binder.retrying).toBe(false);
    expect(deleted).toEqual([rootA]);

    // Now B's registration goes bad too, so a repair is pending as well.
    canRegister = false;
    binder.registrationLost(rootB);
    expect(binder.retrying).toBe(true);
    expect(sched.live()).toHaveLength(2);
    // Aiming the repair slot also retries whatever is abandoned, so A gets
    // another attempt here. What `registrationLost` must NOT do is touch its own
    // target: it leaves that bad entry in place on purpose, because a corrupt
    // entry for a live pid suppresses while an absent one is invisible.
    expect(deleted).toEqual([rootA, rootA]);

    // Fire the CLEANUP timer, not the repair one. It fails again and must
    // re-arm on its own slot rather than deferring to the pending repair.
    sched.fireLive(0);
    expect(binder.cleaningUp).toBe(true);
    expect(binder.retrying).toBe(true);
    expect(sched.live()).toHaveLength(2);
    // And the root under repair was NEVER a cleanup target. With `boundRoot`
    // null this is the whole protection: cleanup that keeps only the bound root
    // would delete B's entry and its vouch here, trading a suppressing corrupt
    // entry for invisibility and widening the fail-open window that the pending
    // repair exists to close.
    expect(deleted).toEqual([rootA, rootA, rootA]);
    expect(deleted).not.toContain(rootB);
  });

  it("re-aiming the repair hands the abandoned target to cleanup immediately", () => {
    // The gap between the two slots. Re-aiming drops a root out of protection,
    // and the other synchronization points are a successful bind and a release,
    // neither of which is guaranteed to arrive while the new repair keeps
    // failing. Cleanup must not wait on a repair that may never land: the two
    // slots are independent, and this is the direction that is easy to lose.
    const sched = fakeScheduler();
    const deleted: string[] = [];
    let allowDelete = false;
    let canRegister = true;
    const binder = new ServerRegistryBinder({
      register: () => canRegister,
      unregister: (r) => { deleted.push(r); return allowDelete; },
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    const rootA = join(root, "a13");
    const rootB = join(root, "b13");

    binder.bind(rootA);
    expect(binder.root).toBe(rootA);

    // B fails to register, so B becomes the repair target and is protected.
    canRegister = false;
    binder.bind(rootB);
    expect(binder.retrying).toBe(true);
    expect(binder.cleaningUp).toBe(false);
    expect(deleted).toEqual([]);

    // Now A loses its registration. The slot re-aims to A, so B is abandoned.
    binder.registrationLost(rootA);
    expect(binder.retrying).toBe(true);
    // B is attempted right away rather than waiting on A, and because the
    // delete fails it gets its own timer.
    expect(deleted).toEqual([rootB]);
    expect(binder.cleaningUp).toBe(true);
    expect(sched.live()).toHaveLength(2);

    // A never recovers. B is cleaned anyway. Slot 1 is the cleanup timer: the
    // re-aimed repair was scheduled first, the cleanup that followed it second.
    allowDelete = true;
    sched.fireLive(1);
    expect(deleted).toEqual([rootB, rootB]);
    expect(binder.cleaningUp).toBe(false);
    expect(binder.retrying).toBe(true);
  });

  it("cleanup resumes on the repair target once a successful bind cancels it", () => {
    // Protection is scoped to the ACTIVE repair, not permanent. A successful
    // bind elsewhere cancels the pending retry, so its target is abandoned like
    // any other and must go back on the cleanup list; otherwise a root
    // protected once stays protected for the life of the process and its
    // live-pid entry outlives every project we served.
    const sched = fakeScheduler();
    const deleted: string[] = [];
    let canRegister = true;
    const binder = new ServerRegistryBinder({
      register: () => canRegister,
      unregister: (r) => { deleted.push(r); return true; },
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    const rootA = join(root, "a11");
    const rootB = join(root, "b11");

    binder.bind(rootA);
    canRegister = false;
    binder.registrationLost(rootA);
    expect(binder.retrying).toBe(true);

    // Bind elsewhere. A is no longer served and no longer under repair, so the
    // successful bind cleans it up on the spot.
    canRegister = true;
    binder.bind(rootB);
    expect(binder.root).toBe(rootB);
    expect(binder.retrying).toBe(false);
    expect(deleted).toEqual([rootA]);
    expect(binder.cleaningUp).toBe(false);
  });

  it("release cleans up the root a repair was pending for", () => {
    // Protection lasts exactly as long as the repair does. `release` gives up
    // the binding, so it must cancel the pending registration FIRST and only
    // then clean: cleaning while the retry is still armed would leave the
    // repair target protected, and the process exits with a live-pid entry in a
    // project nobody is serving. Order, not just membership.
    const sched = fakeScheduler();
    const deleted: string[] = [];
    let canRegister = true;
    const binder = new ServerRegistryBinder({
      register: () => canRegister,
      unregister: (r) => { deleted.push(r); return true; },
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    const rootA = join(root, "a12");

    binder.bind(rootA);
    canRegister = false;
    binder.registrationLost(rootA);
    expect(binder.retrying).toBe(true);
    expect(deleted).toEqual([]);

    binder.release();
    expect(deleted).toEqual([rootA]);
    expect(binder.retrying).toBe(false);
    expect(binder.cleaningUp).toBe(false);
    expect(sched.live()).toHaveLength(0);
  });

  it("release resets the backoff so a fresh lifecycle gets the fast first retry", () => {
    // Same bound-defeating inheritance as the re-aim path, reached the other
    // way: escalate, release, and the next failed bind would otherwise schedule
    // its first retry 30 seconds out.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    binder.bind(blocked);
    for (let i = 0; i < RETRY_BACKOFF_MS.length + 1; i++) sched.fire();
    const escalated = sched.timers[sched.timers.length - 1]?.ms;
    expect(escalated).toBe(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);

    binder.release();
    expect(sched.live()).toHaveLength(0);

    binder.bind(blocked);
    expect(sched.live()).toHaveLength(1);
    expect(sched.live()[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);
  });

  it("releasing a binder that never bound does not demote the process", () => {
    // A CLI-like process is not an unregistered SERVER, and the difference is
    // not cosmetic: `mcp-unregistered` makes `refreshLease` clear a
    // predecessor's recorded pid pair instead of preserving it.
    const binder = binderWith(fakeScheduler());
    binder.release();
    binder.release();
    expect(binder.root).toBeNull();
    expect(mcpProcessRole()).toBe("cli");
  });

  it("release leaves the binder able to bind the same root again", () => {
    // `release` used to unregister without clearing `boundRoot`, so the binder
    // reported a registration it had just deleted: `bind` on that root returned
    // early as a no-op, the entry could never be restored, and the process kept
    // the registered role while stamping its pid onto the sessions it served.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const rootA = join(root, "a7");
    fs.mkdirSync(rootA, { recursive: true });
    const entryA = join(rootA, ".story", "servers", String(process.pid));
    try {
      binder.bind(rootA);
      expect(fs.existsSync(entryA)).toBe(true);

      binder.release();
      expect(binder.root).toBeNull();
      expect(mcpProcessRole()).toBe("mcp-unregistered");
      expect(fs.existsSync(entryA)).toBe(false);

      binder.bind(rootA);
      expect(binder.root).toBe(rootA);
      expect(fs.existsSync(entryA)).toBe(true);
    } finally {
      unregisterMcpServer(rootA);
      clearSelfVouch(rootA);
    }
  });

  it("a loss reported for a root we do not hold is ignored", () => {
    // One binder holds one root. A failure against some other path says nothing
    // about the registration we have, and demoting on it would take a healthy
    // server offline for somebody else's problem.
    const sched = fakeScheduler();
    const binder = binderWith(sched, OWNER);
    const usable = join(root, "usable2");
    fs.mkdirSync(usable, { recursive: true });
    try {
      binder.bind(usable);
      binder.registrationLost(join(root, "somewhere-else"));
      binder.registrationLost(null);
      binder.registrationLost(undefined);
      expect(binder.root).toBe(usable);
      expect(mcpProcessRole()).toBe("mcp-registered");
      expect(sched.live()).toHaveLength(0);
    } finally {
      unregisterMcpServer(usable);
      clearSelfVouch(usable);
    }
  });

  it("the binder passes its resolved identity through to the registry", () => {
    const sched = fakeScheduler();
    const seen: Array<OwnerTask | null> = [];
    const binder = new ServerRegistryBinder({
      register: (_root, identity) => { seen.push(identity); return true; },
      unregister: () => true,
      identity: () => OWNER,
      markRegistered: markMcpServerProcess,
      markUnregistered: markMcpServerUnregistered,
      schedule: sched.schedule,
      onExit: (release) => { exitReleases.push(release); },
      log: () => { /* quiet */ },
    });
    binder.bind(root);
    expect(seen).toEqual([OWNER]);
  });
});
