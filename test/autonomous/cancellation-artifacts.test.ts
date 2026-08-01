/**
 * T-450 step 6a commit B2a: the transition reader and the two durable artifacts.
 *
 * These are the pieces recovery reads to decide whether a cancellation
 * finished. Nothing here is wired into the guide yet; B2b does that.
 *
 * THE ONE RULE BEHIND ALL OF IT. An unreadable artifact is not an absent one.
 * Absence is an observation with a remedy (proceed, and write the thing).
 * Unreadable is a refusal to look, and treating it as absence would let a
 * transient IO failure manufacture the conclusion that recovery is complete.
 * The vocabulary is borrowed from `BusEvidenceRead` (runtime-evidence.ts:60-67),
 * whose own comment states it: "the classifier must never treat an unreadable
 * file as absence, which would mask a loss."
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCancellationTransition,
  classifyCompletionMarker,
  writeCompletionMarker,
  writeShutdownArtifact,
  readShutdownArtifact,
} from "../../src/autonomous/cancellation-transition.js";
import { CANCELLATION_SHUTDOWN_ARTIFACT } from "../../src/autonomous/session-types.js";

const TID = "11111111-2222-4333-8444-555555555555";
const OTHER_TID = "99999999-8888-4777-8666-555555555555";
const SESSION_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ISO = "2026-08-01T12:00:00.000Z";

function validTransition(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "stash_pending",
    transitionId: TID,
    action: "ordinary_cancellation",
    authority: { kind: "legacy" },
    disposition: { kind: "released", ticketId: "T-001" },
    sessionId: SESSION_UUID,
    sessionStartedAt: ISO,
    transitionStartedRevision: 7,
    stash: { outcome: null },
    ...over,
  };
}

describe("T-450: readCancellationTransition classifies rather than throws", () => {
  it("reports absent for undefined, which is every session that never cancelled", () => {
    // The overwhelmingly common case. It must be cheap and must not be
    // confused with corruption.
    expect(readCancellationTransition(undefined).kind).toBe("absent");
  });

  it("reports valid and returns the parsed record", () => {
    const read = readCancellationTransition(validTransition());
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid") throw new Error("unreachable");
    expect(read.transition.transitionId).toBe(TID);
    expect(read.transition.phase).toBe("stash_pending");
  });

  it("reports malformed for garbage instead of throwing", () => {
    // The tolerant session-schema boundary means ANYTHING can arrive here,
    // including values no writer of ours produced. Throwing would propagate out
    // of a lookup that must stay survivable.
    for (const garbage of ["not-an-object", 42, [], null, {}, { phase: "nonsense" }]) {
      const read = readCancellationTransition(garbage);
      expect(read.kind, `${JSON.stringify(garbage)} was not classified malformed`).toBe("malformed");
      if (read.kind === "malformed") expect(read.detail.length).toBeGreaterThan(0);
    }
  });

  it("reports malformed for a record that lies about action and authority", () => {
    // The pairing is enforced by the schema, and the reader must surface that
    // as malformed rather than silently accepting the half that parses.
    const lying = validTransition({
      action: "candidate_recovery_takeover",
      authority: { kind: "legacy" },
    });
    expect(readCancellationTransition(lying).kind).toBe("malformed");
  });

  it("distinguishes null from undefined, because only one of them is a WRITE", () => {
    // `undefined` is a field that was never set. `null` is a field something
    // deliberately set to null, which no writer of ours does, so it is a
    // corrupt value rather than an absence.
    expect(readCancellationTransition(undefined).kind).toBe("absent");
    expect(readCancellationTransition(null).kind).toBe("malformed");
  });
});

describe("T-450: the completion marker distinguishes ownership from shape", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sb-complete-")); });
  afterEach(() => {
    try { chmodSync(join(dir, "telemetry"), 0o700); } catch { /* may not exist */ }
    rmSync(dir, { recursive: true, force: true });
  });

  function plant(content: unknown): void {
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(
      join(dir, "telemetry", "cancellation-complete.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  it("absent when nothing was ever written", () => {
    expect(classifyCompletionMarker(dir, TID).kind).toBe("absent");
  });

  it("matching when this transition wrote it", () => {
    writeCompletionMarker(dir, TID, ISO);
    expect(classifyCompletionMarker(dir, TID).kind).toBe("matching");
  });

  it("owned-mismatched when the id matches but a field is wrong", () => {
    // Repairable: the record is ours, it is merely incomplete or stale.
    plant({ schemaVersion: 1, transitionId: TID });
    expect(classifyCompletionMarker(dir, TID).kind).toBe("owned-mismatched");
  });

  it("FOREIGN when a valid marker carries a different transition id", () => {
    // The distinction that matters most. This is durable evidence of a
    // COMPETING transition, and overwriting it would destroy the only trace of
    // it. Recovery must refuse rather than repair.
    plant({ schemaVersion: 1, transitionId: OTHER_TID, completedAt: ISO });
    const read = classifyCompletionMarker(dir, TID);
    expect(read.kind).toBe("foreign");
    if (read.kind === "foreign") expect(read.owner).toBe(OTHER_TID);
  });

  it("malformed when no id can be extracted at all", () => {
    // Ownership is unprovable in EITHER direction, so neither repairing nor
    // declaring completion is honest. The operator gets told which file.
    for (const bad of ["{ not json", { schemaVersion: 1 }, [], "null"]) {
      plant(bad);
      const read = classifyCompletionMarker(dir, TID);
      expect(read.kind, `${JSON.stringify(bad)} was not malformed`).toBe("malformed");
    }
  });

  it("io-unreadable is NOT absent", () => {
    // THE RULE. A directory we cannot enter is not a directory with no marker
    // in it. Reporting absence here would let a permissions blip conclude that
    // recovery may proceed and then declare itself complete.
    plant({ schemaVersion: 1, transitionId: TID, completedAt: ISO });
    chmodSync(join(dir, "telemetry"), 0o000);
    const read = classifyCompletionMarker(dir, TID);
    // Some environments (notably running as root) can still read a 000
    // directory. Skip rather than assert a falsehood about the environment.
    if (read.kind === "matching") return;
    expect(read.kind).toBe("io-unreadable");
  });

  it("a path component that is a regular file is unreadable, NOT absent", () => {
    // ENOTDIR looks like absence and is not. `mkdirSync(..., {recursive: true})`
    // answers it with EEXIST rather than repairing it, so classifying it absent
    // would tell recovery to proceed and write, and that write can never
    // succeed. Recovery would spin instead of surfacing a broken session dir.
    writeFileSync(join(dir, "telemetry"), "i am a file, not a directory");
    expect(classifyCompletionMarker(dir, TID).kind).toBe("io-unreadable");
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);
  });

  it("never writes through a temp path another writer could have chosen", () => {
    // `process.pid` is NOT unique across PID namespaces, so two containers
    // writing the same bind-mounted session directory can derive the same temp
    // path; one truncates the other's payload and renames it into place, and
    // both writers return success while only one payload survives, under the
    // other's name. The temp name must therefore be unique per ATTEMPT.
    //
    // Planting a file at the pid-derivable name is the observable form of that:
    // it is exactly the path a colliding writer would hold. It must come
    // through untouched.
    const target = join(dir, "telemetry", "cancellation-complete.json");
    const derivable = `${target}.${process.pid}.tmp`;
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(derivable, "another writer's in-flight payload");

    expect(writeCompletionMarker(dir, TID, ISO)).toBe(true);

    expect(readFileSync(derivable, "utf-8")).toBe("another writer's in-flight payload");
    expect(classifyCompletionMarker(dir, TID).kind).toBe("matching");
  });

  it("leaves no temporary residue after a rename that fails", () => {
    // This is the case that actually exercises the catch-path cleanup: the temp
    // file IS created, and then renameSync fails with EISDIR because the
    // destination is a directory. A write that fails BEFORE creating a temp
    // (an unwritable parent) proves nothing about cleanup.
    mkdirSync(join(dir, "telemetry", "cancellation-complete.json"), { recursive: true });

    expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);

    expect(readdirSync(join(dir, "telemetry"))).toEqual(["cancellation-complete.json"]);
  });

  it("leaves no temporary residue after repeated successful writes", () => {
    // The write goes to a same-directory temp and renames into place, so a
    // reader never observes a half-written file. The readers open fixed
    // basenames and never scan, so residue would not be MISREAD as an artifact;
    // it would accumulate in the telemetry directory and obscure diagnostics,
    // which is reason enough for every attempt to clean up after itself.
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(true);
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(true);
    expect(readdirSync(join(dir, "telemetry"))).toEqual(["cancellation-complete.json"]);
  });

  it("a dangling symlink is unreadable, NOT absent, however much ENOENT says otherwise", () => {
    // ENOENT is the one code that normally licenses `absent`, and reading
    // THROUGH a dangling symlink reports exactly ENOENT. The parent case is
    // decisive: `mkdirSync(..., {recursive: true})` answers a dangling
    // `telemetry` link with ENOENT rather than creating anything, so `absent`
    // would send recovery off to write against a path where the write can never
    // succeed.
    symlinkSync("/definitely/not/a/real/target", join(dir, "telemetry"));
    expect(classifyCompletionMarker(dir, TID).kind).toBe("io-unreadable");
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);
  });

  it("a dangling symlink AT the marker path is unreadable too", () => {
    // Milder than the parent case, because a rename would replace the link, but
    // still not absence: the link may have pointed at a marker that was moved,
    // so "nothing was ever recorded here" is a claim about history we cannot
    // support.
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    symlinkSync("/definitely/not/a/real/target", join(dir, "telemetry", "cancellation-complete.json"));
    expect(classifyCompletionMarker(dir, TID).kind).toBe("io-unreadable");
  });

  it("refuses a telemetry symlink that RESOLVES to a real directory", () => {
    // The dangling case fails by accident (ENOENT); this one would otherwise
    // SUCCEED, which is what makes it the real containment test. `rename(2)`
    // acts on the path entry, so following this link would land session
    // artifacts outside the session directory entirely and could replace an
    // unrelated file there.
    const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
    try {
      symlinkSync(outside, join(dir, "telemetry"));

      expect(classifyCompletionMarker(dir, TID).kind).toBe("io-unreadable");
      expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a marker symlink pointing at valid EXTERNAL json", () => {
    // readFileSync follows symlinks silently and succeeds, so without a
    // pre-read containment check this external file would satisfy the
    // completion gate: a session would be declared durably finished on the
    // strength of a file it never wrote.
    const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
    try {
      const planted = join(outside, "planted.json");
      writeFileSync(planted, JSON.stringify({ schemaVersion: 1, transitionId: TID, completedAt: ISO }));
      mkdirSync(join(dir, "telemetry"), { recursive: true });
      symlinkSync(planted, join(dir, "telemetry", "cancellation-complete.json"));

      expect(classifyCompletionMarker(dir, TID).kind).toBe("io-unreadable");
      expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);
      // The external file is neither read as ours nor replaced.
      expect(JSON.parse(readFileSync(planted, "utf-8")).transitionId).toBe(TID);
      expect(readdirSync(outside)).toEqual(["planted.json"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes a marker that classifies as matching and carries the completion time", () => {
    writeCompletionMarker(dir, TID, ISO);
    const raw = JSON.parse(readFileSync(join(dir, "telemetry", "cancellation-complete.json"), "utf-8"));
    expect(raw).toMatchObject({ schemaVersion: 1, transitionId: TID, completedAt: ISO });
  });

  it("reports failure instead of throwing when the marker cannot be written", () => {
    // The caller's contract is that a failed marker write leaves recovery OPEN.
    // A throw would abort the tail instead, and a silent success would close
    // recovery over a marker that does not exist. A controlled fixture rather
    // than an absolute unwritable path, which a privileged runner could create.
    writeFileSync(join(dir, "telemetry"), "a file where the directory should be");
    expect(() => writeCompletionMarker(dir, TID, ISO)).not.toThrow();
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);
  });
});

describe("T-450: the shutdown artifact records what was actually done", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sb-shutdown-")); });
  afterEach(() => {
    try { chmodSync(join(dir, "telemetry"), 0o700); } catch { /* may not exist */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips every outcome combination", () => {
    for (const sidecar of ["signalled", "already-absent", "declined"] as const) {
      for (const resumeMarker of ["removed", "absent", "preserved-foreign", "preserved-unstructured"] as const) {
        expect(writeShutdownArtifact(dir, TID, { sidecar, resumeMarker })).toBe(true);
        const read = readShutdownArtifact(dir);
        expect(read.kind).toBe("present");
        if (read.kind !== "present") throw new Error("unreachable");
        expect(read.artifact).toMatchObject({ transitionId: TID, sidecar, resumeMarker });
      }
    }
  });

  it("lands at the exact basename the transition record can name", () => {
    // The record carries a LITERAL filename, so this is the one place the two
    // must agree. Asserting the constant rather than a string keeps them from
    // drifting apart silently.
    writeShutdownArtifact(dir, TID, { sidecar: "declined", resumeMarker: "absent" });
    expect(existsSync(join(dir, "telemetry", CANCELLATION_SHUTDOWN_ARTIFACT))).toBe(true);
  });

  it("reports absent, corrupt and present as three different things", () => {
    expect(readShutdownArtifact(dir).kind).toBe("absent");

    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(join(dir, "telemetry", CANCELLATION_SHUTDOWN_ARTIFACT), "{ not json");
    expect(readShutdownArtifact(dir).kind).toBe("corrupt");

    writeShutdownArtifact(dir, TID, { sidecar: "signalled", resumeMarker: "removed" });
    expect(readShutdownArtifact(dir).kind).toBe("present");
  });

  it("rejects an artifact whose outcome is outside the vocabulary", () => {
    // A value we do not recognize is not a value we may act on. Accepting it
    // would let an edited file steer the completion gate.
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(
      join(dir, "telemetry", CANCELLATION_SHUTDOWN_ARTIFACT),
      JSON.stringify({ schemaVersion: 1, transitionId: TID, sidecar: "obliterated", resumeMarker: "removed" }),
    );
    expect(readShutdownArtifact(dir).kind).toBe("corrupt");
  });

  it("io-unreadable is NOT absent, and this is the arm the gate turns on", () => {
    // THE RULE again, and it bites hardest here. The completion gate consumes
    // this artifact as its proof of what the shutdown did. If an unreadable
    // artifact reported `absent`, a permissions blip would be indistinguishable
    // from a shutdown that never ran, and the gate would rerun a tail that had
    // in fact already completed.
    writeShutdownArtifact(dir, TID, { sidecar: "signalled", resumeMarker: "removed" });
    chmodSync(join(dir, "telemetry"), 0o000);
    const read = readShutdownArtifact(dir);
    // Running as root can read a 000 directory. Skip rather than assert a
    // falsehood about the environment.
    if (read.kind === "present") return;
    expect(read.kind).toBe("io-unreadable");
  });

  it("refuses an artifact carrying keys it does not understand", () => {
    // A file with extra fields is a file written by something that is not this
    // module. Reading only the parts we recognize would let the gate act on a
    // record whose actual meaning we do not know.
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(
      join(dir, "telemetry", CANCELLATION_SHUTDOWN_ARTIFACT),
      JSON.stringify({
        schemaVersion: 1, transitionId: TID, sidecar: "signalled",
        resumeMarker: "removed", verdict: "complete",
      }),
    );
    expect(readShutdownArtifact(dir).kind).toBe("corrupt");
  });

  it("a path component that is a regular file is unreadable, NOT absent", () => {
    // Same rule as the completion marker, and it matters more here: the gate
    // treats `absent` as "the shutdown never ran" and would rerun a tail that
    // may already have completed.
    writeFileSync(join(dir, "telemetry"), "i am a file, not a directory");
    expect(readShutdownArtifact(dir).kind).toBe("io-unreadable");
    expect(writeShutdownArtifact(dir, TID, { sidecar: "signalled", resumeMarker: "removed" })).toBe(false);
  });

  it("never throws on a write it cannot perform", () => {
    // Controlled fixture rather than an absolute unwritable path, which a
    // privileged test runner could simply create.
    writeFileSync(join(dir, "telemetry"), "a file where the directory should be");
    const attempt = () => writeShutdownArtifact(dir, TID, { sidecar: "declined", resumeMarker: "absent" });
    expect(attempt).not.toThrow();
    expect(attempt()).toBe(false);
  });

  it("refuses a telemetry symlink that RESOLVES to a real directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
    try {
      symlinkSync(outside, join(dir, "telemetry"));
      expect(readShutdownArtifact(dir).kind).toBe("io-unreadable");
      expect(writeShutdownArtifact(dir, TID, { sidecar: "signalled", resumeMarker: "removed" })).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a shutdown-artifact symlink pointing at valid EXTERNAL json", () => {
    const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
    try {
      const planted = join(outside, "planted.json");
      writeFileSync(planted, JSON.stringify({
        schemaVersion: 1, transitionId: TID, sidecar: "signalled", resumeMarker: "removed",
      }));
      mkdirSync(join(dir, "telemetry"), { recursive: true });
      symlinkSync(planted, join(dir, "telemetry", CANCELLATION_SHUTDOWN_ARTIFACT));

      // Otherwise external JSON would satisfy the completion gate's proof of
      // what the shutdown did.
      expect(readShutdownArtifact(dir).kind).toBe("io-unreadable");
      expect(writeShutdownArtifact(dir, TID, { sidecar: "declined", resumeMarker: "absent" })).toBe(false);
      expect(JSON.parse(readFileSync(planted, "utf-8")).sidecar).toBe("signalled");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a dangling telemetry symlink is unreadable, NOT absent", () => {
    symlinkSync("/definitely/not/a/real/target", join(dir, "telemetry"));
    expect(readShutdownArtifact(dir).kind).toBe("io-unreadable");
    expect(writeShutdownArtifact(dir, TID, { sidecar: "signalled", resumeMarker: "removed" })).toBe(false);
  });
});
