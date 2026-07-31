/**
 * T-450 step 2: the owner-liveness probe.
 *
 * The probe is the ONLY place the guard reaches the autonomous liveness
 * runtime. It exists because the classifier must stay pure and `session-scan`
 * must stay a plain status path that performs no process lookups, while the
 * handshake needs three values that no single existing surface carries:
 * the verdict, the session revision, and the evidence fingerprint.
 *
 * KEYED BY DIRECTORY, NOT BY ID. The guard deliberately supports duplicate
 * embedded session ids in different source directories and classifies BOTH the
 * survivor and the dropped participant. Liveness is a property of a DIRECTORY,
 * so one directory's evidence applied to another manufactures a candidate out
 * of nothing. The map is nested `sessionId -> sourceDir`, never a concatenated
 * string key, because a concatenation is a parsing problem waiting to happen on
 * ids and directory names this code does not control.
 *
 * OBSERVATION ONLY. Step 2 publishes nothing: no new relationship, action,
 * capability or verdict field. The guard is not wired to this yet, and the last
 * test here pins that its output is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  probeOwnerLiveness,
  type OwnerLivenessEvidence,
} from "../../src/core/owner-liveness-probe.js";
import { evaluateSessionGuard } from "../../src/core/session-guard.js";
import { OWNER_STALE_MS } from "../../src/autonomous/liveness.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";

const NOW = Date.parse("2027-03-01T12:00:00.000Z");
const STALE = new Date(NOW - (OWNER_STALE_MS + 60_000)).toISOString();
const FRESH = new Date(NOW - 5_000).toISOString();
const OWNER: OwnerTask = { client: "claude", id: "owner-task-aaa", boundAt: STALE };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-probe-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Write a session directory whose NAME is `sourceDir` and whose embedded id is
 * `sessionId`. The two differing is the whole point of the collision cases: the
 * id is file content, the directory is the address.
 */
function writeSession(sourceDir: string, sessionId: string, overrides: Record<string, unknown> = {}): string {
  const dir = join(root, ".story", "sessions", sourceDir);
  fs.mkdirSync(join(dir, "telemetry"), { recursive: true });
  const state = {
    schemaVersion: 5,
    sessionId,
    recipe: "default",
    state: "IMPLEMENT",
    previousState: null,
    revision: 7,
    status: "active",
    mode: "auto",
    startedAt: STALE,
    lastGuideCall: STALE,
    mcpServerPid: null,
    mcpGuideCallAt: null,
    ownerTask: OWNER,
    completedTickets: [],
    resolvedIssues: [],
    ...overrides,
  };
  fs.writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  return dir;
}

/** The scan shape the probe consumes. Only the two fields it keys on matter. */
function summary(sourceDir: string, sessionId: string) {
  return { sessionId, sourceDir, state: "IMPLEMENT", mode: "auto", ticketId: null, ticketTitle: null };
}

function only(map: ReturnType<typeof probeOwnerLiveness>, sessionId: string, sourceDir: string): OwnerLivenessEvidence {
  const inner = map.get(sessionId);
  expect(inner, `no entry for ${sessionId}`).toBeDefined();
  const ev = inner!.get(sourceDir);
  expect(ev, `no entry for ${sessionId}/${sourceDir}`).toBeDefined();
  return ev!;
}

/** Allocate a pid that is provably not running, rather than guessing one. */
function deadPid(): number {
  // Wide on purpose. On a host with a large `pid_max` the low end of this
  // range can be genuinely occupied, and a fixture that gives up after 200
  // candidates would fail for a reason that has nothing to do with the code
  // under test. Failure is still LOUD rather than a silently live pid.
  for (let candidate = 900_000; candidate < 1_000_000; candidate++) {
    try { process.kill(candidate, 0); } catch (e: any) {
      if (e?.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead pid for the fixture");
}

/**
 * A session whose evidence reaches `gone-candidate`: stale activity, a
 * corroborating shutdown marker, a sidecar pid file, and a recorded MCP pid
 * that is definitively gone. Only this path re-reads owner state.
 */
function candidateSession(sourceDir: string, sessionId: string, overrides: Record<string, unknown> = {}): string {
  const pid = deadPid();
  const dir = writeSession(sourceDir, sessionId, { mcpServerPid: pid, mcpGuideCallAt: STALE, ...overrides });
  const tDir = join(dir, "telemetry");
  fs.writeFileSync(join(tDir, "shutdown"), STALE);
  fs.utimesSync(join(tDir, "shutdown"), new Date(NOW - 60_000), new Date(NOW - 60_000));
  fs.writeFileSync(join(tDir, "sidecar.pid"), String(pid));
  return dir;
}

/**
 * An enumerable, empty registry. Without it `liveMcpServers` reports
 * `unavailable` on a project that never ran a server, which suppresses every
 * candidate into `undetermined` and would make the candidate fixtures below
 * silently test nothing.
 */
const NO_SERVERS = () => ({ kind: "observed" as const, servers: [] });

function candidateSnapshot(revision: number) {
  return {
    revision,
    lastGuideCall: STALE,
    mcpServerPid: deadPid(),
    mcpGuideCallAt: STALE,
    lease: null,
    ownerTask: OWNER,
  };
}

describe("T-450: the probe keys evidence by directory, not by id", () => {
  it("gives two sessions sharing an id their OWN evidence", () => {
    // The collision the guard supports. A flat `sessionId` key would overwrite
    // one participant with the other's evidence, and since liveness is a
    // property of a directory, that is how a live owner acquires a dead one's
    // death marker.
    writeSession("dir-a", "shared-id", { revision: 11 });
    writeSession("dir-b", "shared-id", { revision: 22, lastGuideCall: FRESH });

    const map = probeOwnerLiveness(root, [summary("dir-a", "shared-id"), summary("dir-b", "shared-id")], { now: NOW });

    expect(map.get("shared-id")!.size).toBe(2);
    expect(only(map, "shared-id", "dir-a").sessionRevision).toBe(11);
    expect(only(map, "shared-id", "dir-b").sessionRevision).toBe(22);
    // Different observations, so different pictures.
    expect(only(map, "shared-id", "dir-a").evidenceFingerprint)
      .not.toBe(only(map, "shared-id", "dir-b").evidenceFingerprint);
  });

  it("nests rather than concatenating, so no id or directory name can forge a key", () => {
    // A concatenated key is a parsing problem on values this code does not
    // control: a session id containing the separator would address another
    // session's slot. Nesting removes the question.
    writeSession("b", "a-x");
    const map = probeOwnerLiveness(root, [summary("b", "a-x")], { now: NOW });
    for (const key of map.keys()) expect(key).toBe("a-x");
    expect([...map.get("a-x")!.keys()]).toEqual(["b"]);
  });

  it("probes each participant against its OWN directory", () => {
    // dir-a is stale with a corroborating shutdown marker; dir-b is fresh.
    // If either were probed against the other's directory the verdicts swap.
    const a = writeSession("dir-a", "shared-id");
    fs.writeFileSync(join(a, "telemetry", "shutdown"), STALE);
    writeSession("dir-b", "shared-id", { lastGuideCall: FRESH });

    const map = probeOwnerLiveness(root, [summary("dir-a", "shared-id"), summary("dir-b", "shared-id")], { now: NOW });

    expect(only(map, "shared-id", "dir-b").verdict.kind).toBe("active");
    expect(only(map, "shared-id", "dir-a").verdict.kind).not.toBe("active");
  });
});

describe("T-450: the probe's three values come from ONE observation", () => {
  it("returns a revision that belongs to the same read as the verdict", () => {
    writeSession("d", "s", { revision: 42 });
    const ev = only(probeOwnerLiveness(root, [summary("d", "s")], { now: NOW }), "s", "d");
    expect(ev.sessionRevision).toBe(42);
    expect(ev.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("carries `ownerTask` through, or the feature is inert", () => {
    // The corrective made succession identity-bound, so a state observation
    // without `ownerTask` yields `owner-identity-unrecorded` and every verdict
    // collapses to `undetermined`. The probe is the only thing standing between
    // the guard and that, so it must read the field rather than leaving the
    // default.
    //
    // Both fixtures need a definitively dead RECORDED pid and an enumerable
    // registry, or marker validity answers `no-recorded-pid` before it ever
    // looks at the identity and the assertions below pass whatever the probe
    // does with `ownerTask`.
    candidateSession("d", "s");
    const withOwner = only(probeOwnerLiveness(root, [summary("d", "s")], {
      now: NOW, readSuccessors: NO_SERVERS,
    }), "s", "d");
    expect(withOwner.verdict.signals.markerValidity.kind).toBe("not-invalidated");
    expect(withOwner.verdict.kind).toBe("gone-candidate");

    const pid = deadPid();
    const dir2 = writeSession("d2", "s2", { ownerTask: null, mcpServerPid: pid, mcpGuideCallAt: STALE });
    fs.writeFileSync(join(dir2, "telemetry", "shutdown"), STALE);
    fs.writeFileSync(join(dir2, "telemetry", "sidecar.pid"), String(pid));
    const without = only(probeOwnerLiveness(root, [summary("d2", "s2")], {
      now: NOW, readSuccessors: NO_SERVERS,
    }), "s2", "d2");
    expect(without.verdict.signals.markerValidity.reason).toBe("owner-identity-unrecorded");
    expect(without.verdict.kind).toBe("undetermined");
  });

  it("reads the heartbeat generation, or it observes another owner's telemetry", () => {
    // A session that HAS a generation and is observed without one reads the
    // LEGACY directory, which after a takeover holds the previous owner's
    // marker. The probe is the only thing between the guard and that, so the
    // field is read here for the same reason `ownerTask` is.
    const id = "abcdefghjkmnpqrs";
    const dir = candidateSession("d", "s", { heartbeatGeneration: id });
    // Move the corroborating telemetry into the generation the state names.
    const gen = join(dir, "telemetry", "generations", id);
    fs.mkdirSync(gen, { recursive: true });
    for (const name of ["shutdown", "sidecar.pid"]) {
      fs.renameSync(join(dir, "telemetry", name), join(gen, name));
    }
    fs.utimesSync(join(gen, "shutdown"), new Date(NOW - 60_000), new Date(NOW - 60_000));
    const ev = only(probeOwnerLiveness(root, [summary("d", "s")], {
      now: NOW, readSuccessors: NO_SERVERS,
    }), "s", "d");
    expect(ev.verdict.kind).toBe("gone-candidate");
  });

  it("passes a DAMAGED generation through as damage, not as absence", () => {
    // Absence selects the legacy telemetry directory, which after a takeover
    // holds the previous owner's marker. Coercing a present-but-invalid value
    // to null here would therefore turn damaged state into another owner's
    // evidence. The resolver decides, and it decides refusal.
    for (const damaged of [{}, "", 42, ["x"]] as unknown[]) {
      const dir = `d${JSON.stringify(damaged).replace(/[^a-z0-9]/gi, "")}`;
      candidateSession(dir, dir, { heartbeatGeneration: damaged });
      const ev = only(probeOwnerLiveness(root, [summary(dir, dir)], {
        now: NOW, readSuccessors: NO_SERVERS,
      }), dir, dir);
      expect(ev.verdict.kind, JSON.stringify(damaged)).toBe("undetermined");
    }
  });

  it("re-reads state during evaluation rather than reusing one snapshot", () => {
    // `readOwnerLiveness` deliberately re-reads the owner's own state LAST,
    // because that is the most direct refutation available and the window
    // between the first read and the verdict is exactly where a live owner
    // reappears. Collapsing it to a single cached read would silently remove
    // that refutation.
    //
    // The fixture must reach the CANDIDATE path, since that is the only path
    // that re-reads. Anything short of it returns on the first observation.
    const dir = candidateSession("d", "s");
    let reads = 0;
    const ev = only(probeOwnerLiveness(root, [summary("d", "s")], {
      now: NOW,
      readSuccessors: NO_SERVERS,
      readSessionState: (sessionDir) => {
        reads += 1;
        expect(sessionDir).toBe(dir);
        return candidateSnapshot(9);
      },
    }), "s", "d");
    expect(ev.verdict.kind).toBe("gone-candidate");
    expect(reads).toBeGreaterThan(1);
    expect(ev.sessionRevision).toBe(9);
  });

  it("omits a session whose revision MOVED between reads", () => {
    // The coherence rule, and the reason it is not "take the last read". The
    // re-read replaces the activity, marker-validity and successor signals but
    // carries the lease, death marker and sidecar probe over from the FIRST
    // read, so a shipped signal set can straddle two reads. Attributing it to
    // either revision would be a guess. One revision across every read is the
    // proof that there was nothing to attribute; a revision that moved means
    // the owner wrote while we were looking, which is not evidence of absence.
    let reads = 0;
    candidateSession("d", "s");
    const map = probeOwnerLiveness(root, [summary("d", "s")], {
      now: NOW,
      readSuccessors: NO_SERVERS,
      readSessionState: () => candidateSnapshot(++reads),
    });
    expect(reads).toBeGreaterThan(1);
    expect(map.get("s")).toBeUndefined();
  });

  it("omits a session whose LAST read fails, rather than publishing the first", () => {
    // A later read failing is not a milder problem than the first one failing.
    // Substituting a default-shaped state would let the predicate decide
    // against fabricated absent fields and then publish that verdict under the
    // revision of a read that DID succeed.
    candidateSession("d", "s");
    candidateSession("ok", "s-ok");
    let reads = 0;
    const map = probeOwnerLiveness(root, [summary("d", "s"), summary("ok", "s-ok")], {
      now: NOW,
      readSuccessors: NO_SERVERS,
      readSessionState: (sessionDir) => {
        if (!sessionDir.endsWith("d")) return candidateSnapshot(4);
        reads += 1;
        return reads === 1 ? candidateSnapshot(4) : null;
      },
    });
    expect(reads).toBeGreaterThan(1);
    expect(map.get("s")).toBeUndefined();
    // ...and the rest of the scan is unaffected.
    expect(only(map, "s-ok", "ok").sessionRevision).toBe(4);
  });
});

describe("T-450: the probe refuses to guess", () => {
  it("omits a session whose directory does not exist", () => {
    const map = probeOwnerLiveness(root, [summary("gone", "s")], { now: NOW });
    expect(map.get("s")).toBeUndefined();
  });

  it("omits a session whose state cannot be read, rather than defaulting it", () => {
    // A default-shaped observation is an invented picture: absent activity and
    // no owner identity is a real, meaningful evidence combination, so
    // manufacturing it here would put a fabricated verdict in the map.
    const dir = join(root, ".story", "sessions", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "state.json"), "{ not json");
    const map = probeOwnerLiveness(root, [summary("broken", "s")], { now: NOW });
    expect(map.get("s")).toBeUndefined();
  });

  it("refuses a sourceDir that is not a plain directory name", () => {
    // `sourceDir` is copied verbatim from a directory entry and never
    // validated. Escaping is the obvious risk. The subtler one is
    // `real/../real`, which resolves to a perfectly valid session directory: a
    // containment-only check accepts it, and the same directory then appears
    // under a SECOND key, so the guard sees two participants where one exists.
    writeSession("real", "s");
    writeSession("outer", "s");
    fs.mkdirSync(join(root, ".story", "sessions", "outer", "inner"), { recursive: true });
    const map = probeOwnerLiveness(root, [
      summary("../../etc", "s"),
      summary("real/../real", "s"),
      summary(".", "s"),
      summary("..", "s"),
      // Direct children only. A nested path addresses a directory the scan
      // never produces a row for, and `outer/inner` plus `outer` would file two
      // keys against one subtree.
      summary("outer/inner", "s"),
      summary("real/", "s"),
      summary("real//", "s"),
      summary(join(root, ".story", "sessions", "real"), "s"),
    ], { now: NOW });
    expect(map.get("s")).toBeUndefined();
  });

  it("refuses a symlinked entry, whether it escapes or aliases a sibling", () => {
    // Lexical containment cannot see this. `resolve` is string math and does
    // not follow links, so a symlink named like an ordinary session entry
    // passes every path rule and then reads state from wherever it points:
    // outside the project entirely, or at a SIBLING session, which files one
    // session's evidence under a second key and manufactures a participant.
    writeSession("real", "s-real");
    const outside = mkdtempSync(join(tmpdir(), "t450-outside-"));
    try {
      fs.writeFileSync(join(outside, "state.json"), JSON.stringify({ revision: 1, ownerTask: OWNER }));
      const sessions = join(root, ".story", "sessions");
      try {
        fs.symlinkSync(join(sessions, "real"), join(sessions, "alias"));
        fs.symlinkSync(outside, join(sessions, "escape"));
      } catch (e) {
        // Only a platform that will not create symlinks at all is a reason to
        // skip. Swallowing every error would let an ordinary setup mistake
        // disable the test while it still reports green.
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOSYS") throw e;
        return;
      }
      const map = probeOwnerLiveness(root, [summary("alias", "s-real"), summary("escape", "s-out")], { now: NOW });
      expect(map.get("s-out")).toBeUndefined();
      expect(map.get("s-real")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a differently-cased name on a case-insensitive volume", () => {
    // macOS ships case-INSENSITIVE by default, so `Real` and `real` open the
    // same directory while remaining two distinct map keys: the double
    // participant again, arrived at without a single suspicious character. The
    // entry list reports the true case, which is what settles it. On a
    // case-sensitive volume the row simply names nothing, so the assertion
    // holds either way.
    writeSession("Real", "s");
    const map = probeOwnerLiveness(root, [summary("real", "s")], { now: NOW });
    expect(map.get("s")).toBeUndefined();
    expect(only(probeOwnerLiveness(root, [summary("Real", "s")], { now: NOW }), "s", "Real")).toBeDefined();
  });

  it("refuses an entry that is not a directory at all", () => {
    // A stray file in the sessions tree is not a session, and probing it would
    // attribute whatever the sessions root contains to a session id.
    fs.mkdirSync(join(root, ".story", "sessions"), { recursive: true });
    fs.writeFileSync(join(root, ".story", "sessions", "notes.txt"), "hello");
    expect(probeOwnerLiveness(root, [summary("notes.txt", "s")], { now: NOW }).get("s")).toBeUndefined();
  });

  it("omits a session whose directory is REPLACED mid-evaluation", () => {
    // Membership and `lstat` answer a question about the moment they ran, and
    // every read after that follows a PATH. A directory removed and recreated
    // in between (a concurrent cleanup, a session restarted under a reused
    // name) leaves those reads describing a different directory, and
    // publishing that under this row's key attributes one session's evidence
    // to another. Arranging the swap before the probe runs, as every other
    // alias test does, cannot catch this.
    const sessions = join(root, ".story", "sessions");
    candidateSession("swapped", "s");
    candidateSession("ok", "s-ok");
    let swaps = 0;
    const map = probeOwnerLiveness(root, [summary("swapped", "s"), summary("ok", "s-ok")], {
      now: NOW,
      readSuccessors: NO_SERVERS,
      readSessionState: (sessionDir) => {
        if (sessionDir.endsWith("swapped") && swaps === 0) {
          swaps += 1;
          // RENAMED aside rather than deleted, so the original inode stays
          // allocated. Deleting it first frees the inode, and a filesystem
          // that immediately reuses it would hand the replacement the very
          // identity we captured, failing the test on an implementation that
          // is doing exactly the right thing.
          fs.renameSync(join(sessions, "swapped"), join(sessions, "swapped-moved"));
          fs.mkdirSync(join(sessions, "swapped"), { recursive: true });
        }
        return candidateSnapshot(4);
      },
    });
    expect(swaps).toBe(1);
    expect(map.get("s")).toBeUndefined();
    expect(only(map, "s-ok", "ok").sessionRevision).toBe(4);
  });

  it("treats a PRESENT but malformed ownerTask as no identity, not as an identity", () => {
    // The dangerous shape, and the reason this is not merely tidy validation.
    // A truthy `{}` is not rejected by a cast, and it compares unequal to every
    // live client, so the identity-bound succession check reads it as "the
    // owner is not among them" and reaches `gone-candidate` on an owner that
    // was never established at all. That is the false positive this ticket
    // exists to prevent, arrived at through a damaged field rather than a
    // damaged process.
    const malformed: Record<string, unknown> = {
      empty: {},
      wrongClient: { client: "cursor", id: "abc", boundAt: STALE },
      badId: { client: "claude", id: "not a valid id!", boundAt: STALE },
      noBoundAt: { client: "claude", id: "owner-task-aaa" },
      notAnObject: "owner-task-aaa",
    };
    for (const [name, ownerTask] of Object.entries(malformed)) {
      const pid = deadPid();
      const dir = writeSession(name, name, { ownerTask, mcpServerPid: pid, mcpGuideCallAt: STALE });
      fs.writeFileSync(join(dir, "telemetry", "shutdown"), STALE);
      fs.writeFileSync(join(dir, "telemetry", "sidecar.pid"), String(pid));
      const ev = only(probeOwnerLiveness(root, [summary(name, name)], {
        now: NOW, readSuccessors: NO_SERVERS,
      }), name, name);
      expect(ev.verdict.signals.markerValidity.reason).toBe("owner-identity-unrecorded");
      expect(ev.verdict.kind).toBe("undetermined");
    }
  });

  it("omits a session directory that has no readable state file", () => {
    // A directory can exist with no state file: a session mid-creation, or one
    // whose state was removed while its directory lingered. Defaulting that
    // read would publish a verdict about a session nothing was ever observed
    // about, and `revision: 0` is a real starting revision, not a sentinel a
    // later handshake could recognise as fabricated.
    fs.mkdirSync(join(root, ".story", "sessions", "empty"), { recursive: true });
    expect(probeOwnerLiveness(root, [summary("empty", "s")], { now: NOW }).get("s")).toBeUndefined();
  });

  it("refuses the sessions root ITSELF", () => {
    // `sourceDir: ""` addresses `.story/sessions` directly. A stray state.json
    // there (a partial write, an older layout, a backup) must not be probed as
    // though it were a session: it owns no directory, so the marker, telemetry
    // and sidecar lookups would read whatever the root happens to contain and
    // attribute it to a session that does not exist.
    const base = join(root, ".story", "sessions");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(join(base, "state.json"), JSON.stringify({ sessionId: "s", revision: 3, ownerTask: OWNER }));
    const map = probeOwnerLiveness(root, [summary("", "s"), summary(".", "s")], { now: NOW });
    expect(map.get("s")).toBeUndefined();
  });

  it("omits a session whose state parses but carries no usable revision", () => {
    // The revision is the handshake's compare-and-swap token, so a missing,
    // negative or fractional one is not a value to publish a default for: an
    // authorization confirmed against a token that never existed confirms
    // nothing, and `revision: 0` is a real starting revision, not a sentinel.
    const cases: Array<[string, unknown]> = [["norev", undefined], ["neg", -1], ["frac", 1.5], ["str", "7"]];
    for (const [name, revision] of cases) {
      const d = join(root, ".story", "sessions", name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(join(d, "state.json"), JSON.stringify({ sessionId: "s", revision, ownerTask: OWNER }));
      expect(probeOwnerLiveness(root, [summary(name, "s")], { now: NOW }).get("s")).toBeUndefined();
    }
  });

  it("survives a state read that THROWS, without losing the others", () => {
    // The catch around the evaluation is not decorative. `readOwnerLiveness`
    // calls back into the provider mid-evaluation, so an EACCES or EIO on one
    // session's state.json arrives here as an exception rather than a null.
    // Letting it escape would fail the scan open across every OTHER session in
    // the project, which is a wider blast radius than the one bad directory.
    writeSession("boom", "s-bad");
    writeSession("good", "s-good");
    const map = probeOwnerLiveness(root, [summary("boom", "s-bad"), summary("good", "s-good")], {
      now: NOW,
      readSuccessors: NO_SERVERS,
      readSessionState: (dir) => {
        if (dir.endsWith("boom")) throw new Error("EIO");
        return { revision: 7, lastGuideCall: FRESH, ownerTask: OWNER };
      },
    });
    expect(map.get("s-bad")).toBeUndefined();
    expect(only(map, "s-good", "good").sessionRevision).toBe(7);
  });

  it("consults the project's REAL registry when no successor source is injected", () => {
    // Pins the default wire. A probe that defaulted to "successors
    // unavailable" would answer `undetermined` for every candidate in every
    // project, which is the feature present, green, and inert. The difference
    // is observable without a live server: an absent registry directory is
    // unavailable, while an enumerable empty one is an observation that no
    // successor exists.
    candidateSession("d", "s");
    const beforeDir = only(probeOwnerLiveness(root, [summary("d", "s")], { now: NOW }), "s", "d");
    expect(beforeDir.verdict.kind).toBe("undetermined");

    fs.mkdirSync(join(root, ".story", "servers"), { recursive: true, mode: 0o700 });
    const afterDir = only(probeOwnerLiveness(root, [summary("d", "s")], { now: NOW }), "s", "d");
    expect(afterDir.verdict.kind).toBe("gone-candidate");
  });

  it("survives one unreadable session without losing the others", () => {
    // The bad row must be a REAL enumerated directory whose STATE is unreadable.
    // A nonexistent directory is rejected by entry membership before any read,
    // which tests the membership check over again and says nothing about
    // whether one bad state file can take the scan down with it.
    writeSession("good", "s-good");
    const bad = join(root, ".story", "sessions", "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(join(bad, "state.json"), "{ not json");
    const map = probeOwnerLiveness(root, [summary("bad", "s-bad"), summary("good", "s-good")], { now: NOW });
    expect(map.get("s-bad")).toBeUndefined();
    expect(only(map, "s-good", "good").sessionRevision).toBe(7);
  });
});

describe("T-450 step 2: observation publishes nothing", () => {
  it("leaves guard output byte-identical, with no new verdict fields", () => {
    // Step 2 is shippable precisely because it changes no advertised behavior.
    // The guard does not consult the probe yet; this pins that nothing leaked
    // in early, including the three fields step 9 will add.
    writeSession("d", "s");
    const before = evaluateSessionGuard(root, {});
    probeOwnerLiveness(root, [summary("d", "s")], { now: NOW });
    const after = evaluateSessionGuard(root, {});
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("cancelPermitted");
    expect(after).not.toHaveProperty("sessionRevision");
    expect(after).not.toHaveProperty("evidenceFingerprint");
  });
});
