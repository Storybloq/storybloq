/**
 * T-450 step 6a commit B1: the three shipped primitives, extended IN PLACE.
 *
 * WHY IN PLACE AND NOT WRAPPED. The step 5 characterization suite mocks
 * `liveness.js`, `telemetry-writer.js` and `resume-marker.js` BY PATH and pins
 * each of these calls in the shipped order. A new wrapper defined inside the
 * same module would call its neighbour through the MODULE-LOCAL binding, which
 * `vi.mock` never replaces, so the spy would record nothing and the order test
 * would fail deterministically. Extending the existing exports keeps every call
 * crossing the mocked boundary exactly as it does today.
 *
 * The second reason is narrower and stronger: the old signatures must keep
 * their exact behavior, RETURN VALUE INCLUDED, because other production call
 * sites still use them and none is in this step's scope. For `killSidecar`
 * those are stages/types.ts:127, guide.ts:1127 and guide.ts:2590; `markEnded`
 * and `removeResumeMarker` are reached through `postStateWrite` and the guide's
 * own tail. Each is preserved by an overload whose legacy form returns `void`.
 *
 * The verified and transition-scoped forms are wired into the cancellation tail
 * by commit B2, which also adds the completion gate that consumes their
 * outcomes. Nothing in THIS commit calls them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { killSidecar } from "../../src/autonomous/liveness.js";
import { markEnded, readEndedMarker } from "../../src/autonomous/telemetry-writer.js";
import { removeResumeMarker, writeResumeMarker } from "../../src/autonomous/resume-marker.js";

const ISO = "2026-08-01T12:00:00.000Z";
const OTHER_ISO = "2026-08-01T09:00:00.000Z";
const TID = "11111111-2222-4333-8444-555555555555";
const OTHER_TID = "99999999-8888-4777-8666-555555555555";

// ---------------------------------------------------------------------------
// killSidecar
// ---------------------------------------------------------------------------

describe("T-450: killSidecar keeps its legacy contract and gains a verified mode", () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  function liveProcess(): number {
    // A real process that is definitively NOT a sidecar: its argv carries
    // neither the sidecar marker nor any session directory. Using a real pid
    // rather than a fabricated one matters, because the whole question is what
    // happens when a pid IS live and does NOT belong to us.
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    spawned.push(child);
    return child.pid as number;
  }

  it("without verify, the return value is still undefined", () => {
    // BYTE-IDENTICAL includes the return value. The shipped function returned
    // nothing, and three call sites outside this step's scope
    // (stages/types.ts:127, guide.ts:1127, guide.ts:2590) call it that way.
    // Handing them a new value would be an observable change, however harmlessly
    // they currently ignore it, so the overload keeps that form `void`.
    expect(killSidecar(null)).toBeUndefined();
    expect(killSidecar(undefined)).toBeUndefined();
    expect(killSidecar(0)).toBeUndefined();
    expect(killSidecar(liveProcess())).toBeUndefined();
  });

  it("without verify, a live pid is still signalled blindly", () => {
    // COMPATIBILITY: those same call sites depend on the blind SIGTERM.
    // Extending the signature must not quietly make them identity-checked,
    // which would change behavior nobody reviewed.
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    const pid = child.pid as number;
    spawned.push(child);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    killSidecar(pid);
    return exited;
  });

  it("without verify, a dead pid does not throw", () => {
    expect(() => killSidecar(2_147_483_600)).not.toThrow();
  });

  it("with verify, an absent pid is already-absent and is never probed", () => {
    // The step 5 fixtures never set `sidecarPid`, so once B2 wires the verified
    // form into the tail, this is the path the unedited baseline will exercise:
    // reaching `killSidecar` at the shipped position and doing nothing, exactly
    // as blind `killSidecar(null)` does today.
    const probe = vi.fn((): "match" => "match");
    expect(killSidecar(null, { sessionDir: "/tmp/whatever", probe })).toBe("already-absent");
    expect(probe, "an absent pid has no identity to probe").not.toHaveBeenCalled();
  });

  it("with verify, a LIVE pid that fails the identity probe is declined and NOT signalled", () => {
    // THE CRITICAL CASE. `state.sidecarPid` is written at two sites and never
    // revalidated, while the sidecar it names has several documented ways to
    // exit first, so a recycled pid can belong to anything. Declining is safe
    // because `writeShutdownMarker` remains the guaranteed shutdown channel;
    // signalling would not be.
    const pid = liveProcess();
    const probe = vi.fn((): "unknown" => "unknown");
    expect(killSidecar(pid, { sessionDir: "/tmp/some-session", probe })).toBe("declined");
    expect(probe).toHaveBeenCalled();
    // Still alive: declining means no signal was sent, not that one was sent
    // and ignored.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("with verify, a live pid that passes the probe is signalled", () => {
    const pid = liveProcess();
    expect(killSidecar(pid, { sessionDir: "/tmp/some-session", probe: () => "match" })).toBe("signalled");
  });

  it("with verify, the probe is given BOTH the sidecar marker and this session's directory", () => {
    // Session binding is the entire point. `hasSidecarSignature` alone proves
    // only that a pid is SOME storybloq sidecar, so a recycled pid running a
    // PEER session's sidecar would pass it and be killed.
    const pid = liveProcess();
    const seen: string[][] = [];
    killSidecar(pid, {
      sessionDir: "/tmp/sessions/abc",
      probe: (_p, tokens) => { seen.push([...tokens]); return "unknown"; },
    });
    const flat = seen.flat().join(" ");
    expect(flat, "probe never saw this session's directory").toContain("/tmp/sessions/abc");
    expect(flat.toLowerCase(), "probe never saw a sidecar marker").toContain("sidecar");
  });

  it("with verify, the probe's THREE answers stay three", () => {
    // Collapsing the tri-state to a boolean would record `declined` for a
    // process that is definitively gone. Those are different facts with
    // different remedies: `absent` means there is nothing left to shut down,
    // `declined` means something is alive that we refused to signal. The
    // completion gate that commit B2 adds will read this artifact and must be
    // able to tell them apart.
    const pid = liveProcess();
    expect(killSidecar(pid, { sessionDir: "/tmp/x", probe: () => "absent" })).toBe("already-absent");
    expect(killSidecar(pid, { sessionDir: "/tmp/x", probe: () => "unknown" })).toBe("declined");
    expect(killSidecar(pid, { sessionDir: "/tmp/x", probe: () => "match" })).toBe("signalled");
  });

  it("with verify, a THROWING probe cannot abort the caller's tail", () => {
    // The B2 cancellation tail will wrap this call in nothing, so an escaping
    // throw would skip every effect after it.
    const pid = liveProcess();
    let result: string | undefined;
    expect(() => {
      result = killSidecar(pid, {
        sessionDir: "/tmp/x",
        probe: () => { throw new Error("injected: probe exploded"); },
      });
    }).not.toThrow();
    expect(result, "a probe that failed proves nothing, so nothing may be signalled").toBe("declined");
  });

  it("with verify, a probe throwing an ESRCH-CODED error is declined, not already-absent", () => {
    // The laundering hazard. Only an ESRCH raised by `process.kill` AFTER a
    // successful match proves absence. An error that merely CARRIES that code,
    // thrown from the probe stage, proves nothing, and reporting
    // `already-absent` would write false absence evidence into a durable
    // artifact the completion gate then trusts.
    const pid = liveProcess();
    const esrch = Object.assign(new Error("injected: looks like ESRCH"), { code: "ESRCH" });
    expect(killSidecar(pid, { sessionDir: "/tmp/x", probe: () => { throw esrch; } })).toBe("declined");
    // And the process really is still there, which is what makes
    // `already-absent` a lie rather than a harmless mislabel, once the B2
    // completion gate starts reading these outcomes.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("with verify, a probe whose answer is stale by signal time yields already-absent", async () => {
    // THE TOCTOU SEAM `escalate` documents, modelled honestly.
    //
    // A first version of this test killed the child from inside the probe and
    // expected ESRCH. It got `signalled`, and the reason is worth recording:
    // a killed child whose parent has not reaped it is a ZOMBIE, and a zombie
    // still occupies its pid, so both `kill(pid, 0)` and SIGTERM succeed. The
    // implementation was right and the test's premise was wrong.
    //
    // So the process is fully reaped first (awaiting `exit` does that), and
    // the probe then returns the answer it WOULD have given a moment earlier.
    // That is exactly the shape of the hazard: not a probe that is wrong, but
    // one whose answer has expired by the time the signal is sent. Reporting
    // `signalled` here would put a false claim in a durable audit record.
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });

    const result = killSidecar(pid, { sessionDir: "/tmp/x", probe: () => "match" });
    expect(result).toBe("already-absent");
  });
});

// ---------------------------------------------------------------------------
// markEnded
// ---------------------------------------------------------------------------

describe("T-450: markEnded keeps its legacy contract and gains transition ownership", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sb-ended-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function marker(): Record<string, unknown> | null {
    const p = join(dir, "telemetry", "ended");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  }

  function plant(content: unknown): void {
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(join(dir, "telemetry", "ended"), typeof content === "string" ? content : JSON.stringify(content));
  }

  it("two-argument callers keep the shipped unconditional overwrite and void return", () => {
    plant({ reason: "something-else", timestamp: OTHER_ISO });
    expect(markEnded(dir, "cancelled"), "byte-identical includes the return value").toBeUndefined();
    const m = marker();
    expect(m?.reason).toBe("cancelled");
    expect(m?.transitionId, "legacy writes must not grow a transition id").toBeUndefined();
  });

  it("first pass writes the transition id and the CALLER's timestamp", () => {
    // The caller's `endedAt`, not the writer's clock: recovery running an hour
    // later must be able to reproduce the original termination time, and a
    // marker stamped at recovery time would silently move it.
    markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "first-pass" });
    expect(marker()).toMatchObject({ reason: "cancelled", timestamp: ISO, transitionId: TID });
  });

  it("first pass replaces EXACTLY the closed legacy shape", () => {
    plant({ reason: "cancelled", timestamp: OTHER_ISO });
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "first-pass" })).toBe("written");
    expect(marker()).toMatchObject({ timestamp: ISO, transitionId: TID });
  });

  it("first pass REFUSES an identifier-free marker that is not the legacy shape", () => {
    // A merely parseable timestamp, an unexpected reason, or an extra field
    // each mean this is not the artifact the legacy writer produced, so
    // ownership is unproven and overwriting would destroy someone's evidence.
    for (const bad of [
      { reason: "cancelled", timestamp: "not-a-time" },
      { reason: "superseded", timestamp: OTHER_ISO },
      { reason: "cancelled", timestamp: OTHER_ISO, extra: 1 },
    ]) {
      plant(bad);
      expect(
        markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "first-pass" }),
        `overwrote ${JSON.stringify(bad)}`,
      ).toBe("refused-foreign");
      expect(marker()?.timestamp).toBe(bad.timestamp);
    }
  });

  it("a VALID marker carrying a different transition id is refused on BOTH passes", () => {
    // Holding the session lock stops a concurrent WRITE; it does not turn
    // another transition's durable evidence into ours. Overwriting it would
    // destroy exactly the conflict the ownership classifier exists to surface.
    for (const mode of ["first-pass", "recovery"] as const) {
      plant({ reason: "cancelled", timestamp: OTHER_ISO, transitionId: OTHER_TID });
      expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode })).toBe("refused-foreign");
      expect(marker()?.transitionId).toBe(OTHER_TID);
    }
  });

  it("recovery REPAIRS an owned marker whose timestamp is wrong", () => {
    plant({ reason: "cancelled", timestamp: OTHER_ISO, transitionId: TID });
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "recovery" })).toBe("repaired");
    expect(marker()).toMatchObject({ timestamp: ISO, transitionId: TID });
  });

  it("recovery leaves an already-correct owned marker untouched", () => {
    markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "first-pass" });
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "recovery" })).toBe("already-correct");
  });

  it("recovery REPAIRS an owned marker that carries EXTRA keys", () => {
    // Matching the three expected values is not the same as being the
    // canonical artifact. Calling this "already correct" while the completion
    // reader that B2 adds rejects the extra keys would strand recovery in a
    // loop: forever refusing to repair something that is never accepted.
    plant({ reason: "cancelled", timestamp: ISO, transitionId: TID, strayField: 1 });
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "recovery" })).toBe("repaired");
    expect(Object.keys(marker() ?? {}).sort()).toEqual(["reason", "timestamp", "transitionId"]);
  });

  it("first pass refuses an expanded-year timestamp the legacy writer never emitted", () => {
    // `new Date(t).toISOString() === t` alone also holds for expanded years,
    // so the round trip is not by itself the historical grammar.
    plant({ reason: "cancelled", timestamp: "+275760-09-13T00:00:00.000Z" });
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "first-pass" })).toBe("refused-foreign");
  });

  it("recovery REFUSES an identifier-free legacy marker", () => {
    // The one asymmetry between the passes, and it is deliberate. First pass
    // may adopt legacy content because it provably runs before this transition
    // ever wrote a marker. By recovery time that reasoning is gone: an
    // identifier-free marker could be anyone's.
    plant({ reason: "cancelled", timestamp: OTHER_ISO });
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "recovery" })).toBe("refused-unowned");
    expect(marker()?.timestamp).toBe(OTHER_ISO);
  });

  it("refuses without writing when the marker cannot be read as JSON", () => {
    plant("{ this is not json");
    expect(markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "recovery" })).toBe("refused-unreadable");
    expect(readFileSync(join(dir, "telemetry", "ended"), "utf-8")).toBe("{ this is not json");
  });

  it("still never throws, whatever it decides", () => {
    // The B2 tail will wrap this call in nothing. A throw here would abort the
    // rest of the post-publication sequence, which is the failure mode the step
    // 5 isolation suite exists to prevent.
    expect(() => markEnded("/nonexistent/nope", "cancelled", { transitionId: TID, endedAt: ISO, mode: "recovery" })).not.toThrow();
    expect(() => markEnded("/nonexistent/nope", "cancelled")).not.toThrow();
  });

  it("leaves readEndedMarker able to parse what it writes", () => {
    markEnded(dir, "cancelled", { transitionId: TID, endedAt: ISO, mode: "first-pass" });
    expect(readEndedMarker(dir)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// removeResumeMarker
// ---------------------------------------------------------------------------

describe("T-450: removeResumeMarker gains session identity", () => {
  let root: string;
  const markerPath = (r: string) => join(r, ".claude", "rules", "autonomous-resume.md");

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sb-resume-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function plant(content: string): void {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(markerPath(root), content);
  }

  it("one-argument callers keep the shipped delete-by-path behavior and void return", () => {
    plant("resume me\n");
    expect(removeResumeMarker(root), "byte-identical includes the return value").toBeUndefined();
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it("removes a marker whose recorded session matches", () => {
    // The shipped writer already records `Session: <id>`, so identity is
    // available without a format change and without a migration.
    writeResumeMarker(root, "sess-abc", { ticket: null, completedTickets: [] });
    expect(removeResumeMarker(root, { sessionId: "sess-abc", mode: "first-pass" })).toBe("removed");
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it("PRESERVES a marker belonging to a different session, on both passes", () => {
    for (const mode of ["first-pass", "recovery"] as const) {
      writeResumeMarker(root, "sess-other", { ticket: null, completedTickets: [] });
      expect(removeResumeMarker(root, { sessionId: "sess-abc", mode })).toBe("preserved-foreign");
      expect(existsSync(markerPath(root)), `${mode} deleted a foreign marker`).toBe(true);
    }
  });

  it("first pass deletes UNSTRUCTURED content, recovery preserves it", () => {
    // The asymmetry the step 5 fixture forces. Its marker is the bare string
    // "resume me", which carries no identity at all. B2 will call the
    // first-pass form under the held session lock, where deleting it is the
    // shipped behavior and stays. By recovery time nothing proves whose it is,
    // and declaring completion over it would leave a live instruction to resume
    // a session that is durably finished.
    plant("resume me\n");
    expect(removeResumeMarker(root, { sessionId: "sess-abc", mode: "first-pass" })).toBe("removed");
    expect(existsSync(markerPath(root))).toBe(false);

    plant("resume me\n");
    expect(removeResumeMarker(root, { sessionId: "sess-abc", mode: "recovery" })).toBe("preserved-unstructured");
    expect(existsSync(markerPath(root))).toBe(true);
  });

  it("PRESERVES a marker naming two different sessions", () => {
    // Taking the first `Session:` line would be a fail-OPEN read: a marker
    // naming both this session and a foreign one would be classified as ours
    // and deleted, which is precisely what the foreign rule exists to prevent.
    plant([
      "CRITICAL: An autonomous coding session is active and waiting to resume.",
      "",
      "Session: sess-abc",
      "Session: sess-other",
      "",
    ].join("\n"));
    expect(removeResumeMarker(root, { sessionId: "sess-abc", mode: "first-pass" })).toBe("preserved-foreign");
    expect(existsSync(markerPath(root))).toBe(true);
  });

  it("treats a repeated identical identity as one identity", () => {
    plant(["Session: sess-abc", "Session: sess-abc", ""].join("\n"));
    expect(removeResumeMarker(root, { sessionId: "sess-abc", mode: "recovery" })).toBe("removed");
  });

  it("reports absent when there is nothing to remove", () => {
    expect(removeResumeMarker(root, { sessionId: "sess-abc", mode: "recovery" })).toBe("absent");
  });

  it("never throws", () => {
    expect(() => removeResumeMarker("/nonexistent/nope")).not.toThrow();
    expect(() => removeResumeMarker("/nonexistent/nope", { sessionId: "x", mode: "recovery" })).not.toThrow();
  });
});
