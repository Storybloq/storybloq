/**
 * T-450 step 6b commit 1: the shared-core enablers for candidate recovery.
 *
 * Three seams, none of them yet consumed by a caller-facing surface:
 *
 *   1. `applyCancellationTransition`'s `init` parameter: a FRESH candidate
 *      cancellation cannot reach write 1 through either existing input (the
 *      ordinary default mints its own legacy-authority record; `resume`
 *      structurally requires an already-persisted stash_pending record), so
 *      the shared core gains a third, mutually exclusive one, and enforces the
 *      action-authority pairing and the candidate invariant
 *      `transitionStartedRevision === confirmedSessionRevision + 1` IN ONE
 *      PLACE, refusing before any write.
 *
 *   2. `classifyTailRecovery`: the six-way completion-marker switch wrapped
 *      exactly once, so the candidate published branch cannot drift from the
 *      ordinary gate by re-spelling it.
 *
 *   3. `validateStagedGeneration`: the staged child can exit, lose its
 *      signature, or have its directory replaced between readiness and
 *      publication, so a readiness result from before lock acquisition is not
 *      evidence of liveness at write time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
}));

import {
  applyCancellationTransition,
  classifyTailRecovery,
  type CandidateCancellationInit,
} from "../../src/autonomous/cancellation-core.js";
import {
  readCancellationTransition,
  writeCompletionMarker,
} from "../../src/autonomous/cancellation-transition.js";
import {
  stageHeartbeatGeneration,
  discardStagedGeneration,
  validateStagedGeneration,
  telemetryDirPath,
  __testing,
  type StagedHeartbeatGeneration,
} from "../../src/autonomous/liveness.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { gitStashPop } from "../../src/autonomous/git-inspector.js";
import type { FullSessionState, CancellationAuthority } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();
const INIT_TID = "cccccccc-1111-4222-8333-444444444444";

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

/** The minimal VALID persisted evidence, proven parseable by the 6a suites. */
function minimalEvidence() {
  return {
    activity: { kind: "unknown" as const, reason: "absent" },
    lease: { kind: "unknown" as const, reason: "absent" },
    deathMarker: { kind: "unreadable" as const, reason: "absent" },
    markerValidity: { kind: "unknown" as const, reason: "no-recorded-pid", pid: null },
    sidecarProbe: { kind: "unknown" as const, reason: "no-pid", pid: null },
    observedAt: "2026-08-01T00:00:00.000Z",
    staleThresholdMs: 2_700_000,
    successors: { kind: "unavailable" as const, reason: "test fixture" },
  };
}

function candidateAuthority(confirmedSessionRevision: number): Extract<CancellationAuthority, { kind: "candidate" }> {
  return {
    kind: "candidate",
    clientTaskId: "task-candidate",
    confirmedSessionRevision,
    confirmedFingerprint: "fp-1",
    evidence: minimalEvidence(),
  };
}

function initFor(confirmedSessionRevision: number): CandidateCancellationInit {
  return {
    transitionId: INIT_TID,
    action: "candidate_recovery_takeover",
    authority: candidateAuthority(confirmedSessionRevision),
  };
}

/**
 * A LIVE session (not SESSION_END), as `commitCandidateCancel` sees one when it
 * reaches write 1: intent phases are done, no transition record exists yet.
 * `writeSessionSync` bumps the planted session to revision 1.
 */
function plantLive(root: string, over: Record<string, unknown> = {}): { sessionId: string; sessDir: string; state: FullSessionState } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const written = writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
    ...over,
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir, state: written };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-6b1-"));
  setupProject(root);
  vi.mocked(gitStashPop).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof gitStashPop>>);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("T-450 6b: applyCancellationTransition with candidate init", () => {
  it("runs the full four-write protocol under the pre-minted identity", async () => {
    // The record IS the plan's delta-amendment test (a) seed: it must parse
    // through the shipped strict reader and satisfy the published equations
    // with no adapter between the candidate path and the substrate.
    const { sessDir, state } = plantLive(root);
    expect(state.revision).toBe(1);

    const result = await applyCancellationTransition(
      root, { dir: sessDir, state }, { kind: "no-ticket" }, undefined, initFor(1),
    );

    expect(result.written.state).toBe("SESSION_END");
    const read = readCancellationTransition(
      (readState(sessDir) as unknown as Record<string, unknown>).cancellationTransition,
    );
    if (read.kind !== "valid" || read.transition.phase !== "published") {
      throw new Error(`expected a valid published transition, got ${read.kind}`);
    }
    const t = read.transition;
    expect(t.transitionId).toBe(INIT_TID);
    expect(t.action).toBe("candidate_recovery_takeover");
    expect(t.authority.kind).toBe("candidate");
    // The candidate invariant, satisfied by construction: write 1 produced
    // revision confirmed + 1.
    expect(t.transitionStartedRevision).toBe(2);
    expect(t.terminalRevision).toBe(t.transitionStartedRevision + 2);
    expect(t.stash.outcome).toBe("none");
  });

  it("refuses a confirmed revision that does not name the CURRENT state, before any write", async () => {
    // The invariant is the whole reason the intent lives outside revisioned
    // state: if anything moved the session between authorize and write 1, the
    // confirmation is stale and acting on it would take over a session the
    // human was not shown. Refusal must precede write 1, so the session is
    // byte-identical afterwards and re-authorization starts clean.
    const { sessDir, state } = plantLive(root);
    const before = readFileSync(join(sessDir, "state.json"), "utf-8");

    await expect(
      applyCancellationTransition(root, { dir: sessDir, state }, { kind: "no-ticket" }, undefined, initFor(0)),
    ).rejects.toThrow(/confirmedSessionRevision 0/);

    expect(readFileSync(join(sessDir, "state.json"), "utf-8")).toBe(before);
  });

  it("names both numbers in the refusal", async () => {
    const { sessDir, state } = plantLive(root);
    await expect(
      applyCancellationTransition(root, { dir: sessDir, state }, { kind: "no-ticket" }, undefined, initFor(7)),
    ).rejects.toThrow(/revision 1/);
  });

  it("refuses init and resume together", async () => {
    // Mutually exclusive by contract: init mints write 1, resume forbids it.
    // Accepting both would have to pick one silently, and whichever lost would
    // have its identity discarded without a record.
    const { sessDir, state } = plantLive(root);
    const resume = {
      phase: "stash_pending" as const,
      transitionId: INIT_TID,
      action: "candidate_recovery_takeover" as const,
      authority: candidateAuthority(0),
      disposition: { kind: "no-ticket" as const },
      sessionId: state.sessionId,
      sessionStartedAt: new Date(state.startedAt).toISOString(),
      transitionStartedRevision: 1,
      stash: { outcome: null },
    };
    await expect(
      applyCancellationTransition(
        root, { dir: sessDir, state }, { kind: "no-ticket" },
        resume as Parameters<typeof applyCancellationTransition>[3], initFor(0),
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("refuses a runtime pairing violation the type system cannot see", async () => {
    // The schema's superRefine catches this at READ time, but by then the lie
    // is on disk. The shared core is the one place that can refuse it before
    // the write.
    const { sessDir, state } = plantLive(root);
    const before = readFileSync(join(sessDir, "state.json"), "utf-8");
    const forged = {
      transitionId: INIT_TID,
      action: "candidate_recovery_takeover",
      authority: { kind: "legacy" },
    } as unknown as CandidateCancellationInit;

    await expect(
      applyCancellationTransition(root, { dir: sessDir, state }, { kind: "no-ticket" }, undefined, forged),
    ).rejects.toThrow(/candidate authority/);
    expect(readFileSync(join(sessDir, "state.json"), "utf-8")).toBe(before);
  });

  it("refuses, rather than degrades, when the session start time is unusable", async () => {
    // The ordinary path degrades to the recordless legacy cancel on an
    // unparseable startedAt, because minting a transition is an ENHANCEMENT
    // there. For a candidate the record IS the authorization: a candidate
    // cancellation with no durable transition could never be resumed and its
    // invariant could never be validated, so degradation would be silent
    // authority laundering.
    const { sessDir, state } = plantLive(root, { startedAt: "not-a-date" });
    const before = readFileSync(join(sessDir, "state.json"), "utf-8");

    await expect(
      applyCancellationTransition(root, { dir: sessDir, state }, { kind: "no-ticket" }, undefined, initFor(1)),
    ).rejects.toThrow(/start time/);
    expect(readFileSync(join(sessDir, "state.json"), "utf-8")).toBe(before);
  });

  it("leaves the ordinary path byte-identical: no init means a legacy record", async () => {
    // The no-ordinary-path-deltas rule, asserted from the ordinary caller's
    // seat: absent init, write 1 carries exactly what a3619172 shipped.
    const { sessDir, state } = plantLive(root);
    await applyCancellationTransition(root, { dir: sessDir, state }, { kind: "no-ticket" });
    const read = readCancellationTransition(
      (readState(sessDir) as unknown as Record<string, unknown>).cancellationTransition,
    );
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.action).toBe("ordinary_cancellation");
    expect(read.transition.authority).toEqual({ kind: "legacy" });
  });
});

describe("T-450 6b: classifyTailRecovery wraps the six-way marker switch once", () => {
  const TID = INIT_TID;
  let sessDir: string;

  beforeEach(() => {
    sessDir = join(root, ".story", "sessions", "gate-fixture");
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });
  });

  function markerPath(): string {
    return join(telemetryDirPath(sessDir), "cancellation-complete.json");
  }

  it("absent proceeds, and says which gate opened", () => {
    expect(classifyTailRecovery(sessDir, TID)).toEqual({ kind: "proceed", marker: "absent" });
  });

  it("owned-mismatched proceeds: ours and provably wrong is repairable", () => {
    writeFileSync(markerPath(), JSON.stringify({ schemaVersion: 1, transitionId: TID }));
    expect(classifyTailRecovery(sessDir, TID)).toEqual({ kind: "proceed", marker: "owned-mismatched" });
  });

  it("matching closes recovery", () => {
    writeCompletionMarker(sessDir, TID, NOW);
    expect(classifyTailRecovery(sessDir, TID)).toEqual({ kind: "already-complete" });
  });

  it("foreign refuses and names the owner", () => {
    writeFileSync(markerPath(), JSON.stringify({
      schemaVersion: 1, transitionId: "dddddddd-1111-4222-8333-444444444444", completedAt: NOW,
    }));
    const gate = classifyTailRecovery(sessDir, TID);
    expect(gate).toEqual({
      kind: "refuse", classification: "foreign", owner: "dddddddd-1111-4222-8333-444444444444",
    });
  });

  it("malformed refuses with the detail", () => {
    writeFileSync(markerPath(), "not json");
    expect(classifyTailRecovery(sessDir, TID)).toEqual({
      kind: "refuse", classification: "malformed", detail: "invalid JSON",
    });
  });

  it("io-unreadable refuses: unreadable is never absence", () => {
    // A DIRECTORY at the marker path: containment passes (it is not a
    // symlink), the read throws EISDIR, and the gate must report a refusal to
    // look rather than an absence that would authorize recovery.
    mkdirSync(markerPath());
    const gate = classifyTailRecovery(sessDir, TID);
    expect(gate.kind).toBe("refuse");
    if (gate.kind !== "refuse" || gate.classification === "foreign") throw new Error("expected a detail refusal");
    expect(gate.classification).toBe("io-unreadable");
  });
});

describe("T-450 6b: validateStagedGeneration re-proves liveness at write time", () => {
  const stagedCleanup: StagedHeartbeatGeneration[] = [];
  const realProbe = __testing.probeApi.probeArgvSignature;
  let probeAnswer: "match" | "absent" | "unknown";

  beforeEach(() => {
    probeAnswer = "match";
    __testing.probeApi.probeArgvSignature = () => probeAnswer;
  });

  afterEach(() => {
    __testing.probeApi.probeArgvSignature = realProbe;
    for (const staged of stagedCleanup.splice(0)) {
      try { discardStagedGeneration(staged); } catch { /* best-effort */ }
    }
    __testing.stagingHooks.spawn = null;
  });

  /** A staged generation whose fake child wrote its readiness heartbeat. */
  function stagedFixture(): StagedHeartbeatGeneration {
    __testing.stagingHooks.spawn = (dir: string) => {
      fs.writeFileSync(join(dir, "alive"), String(Date.now()));
      return { pid: 999_999, terminate: () => { /* recorded, not signalled */ } };
    };
    const staged = stageHeartbeatGeneration(root, { readinessTimeoutMs: 400, pollMs: 25 });
    __testing.stagingHooks.spawn = null;
    if (!staged) throw new Error("fixture failed to stage");
    stagedCleanup.push(staged);
    return staged;
  }

  it("validates a generation that is still exactly what readiness acknowledged", () => {
    const staged = stagedFixture();
    expect(validateStagedGeneration(staged)).toEqual({ ok: true });
  });

  it("refuses a handle staging never issued, or one already discarded", () => {
    const staged = stagedFixture();
    discardStagedGeneration(staged);
    expect(validateStagedGeneration(staged)).toEqual({ ok: false, reason: "unknown-handle" });
  });

  it("refuses when the child no longer carries the sidecar signature", () => {
    // The staged child can exit between readiness and lock acquisition, and
    // its pid can be REUSED by an unrelated process. The signature probe is
    // what distinguishes "our sidecar" from "whatever holds that number now";
    // publishing on the stale readiness result would bind the takeover to a
    // heartbeat nobody is writing.
    const staged = stagedFixture();
    probeAnswer = "absent";
    expect(validateStagedGeneration(staged)).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a recycled pid held by a DIFFERENT storybloq sidecar", () => {
    // The generic argv marker matches any storybloq sidecar, of which several
    // can run on one machine. If the staged child dies, another session's
    // sidecar recycles its pid, and the staged directory keeps its readiness
    // heartbeat, species-level probing would publish a takeover bound to a
    // process that will never heartbeat HERE. The probe must require the
    // staged generation directory itself, which the spawn put in the child's
    // argv, so this fake answers "match" for the species and "absent" the
    // moment the probe asks about the directory.
    const staged = stagedFixture();
    __testing.probeApi.probeArgvSignature = (_pid: number, markers: readonly string[]) =>
      markers.includes(staged.dir) ? "absent" : "match";
    expect(validateStagedGeneration(staged)).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("treats an UNKNOWN probe as a refusal, not as a pass", () => {
    // A ps/proc failure proves nothing about the child. Publishing on
    // "unknown" would make probe infrastructure failure an authorization.
    const staged = stagedFixture();
    probeAnswer = "unknown";
    expect(validateStagedGeneration(staged)).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses when the heartbeat is gone from the staged directory", () => {
    const staged = stagedFixture();
    fs.rmSync(join(staged.dir, "alive"));
    expect(validateStagedGeneration(staged)).toEqual({ ok: false, reason: "no-heartbeat" });
  });

  it("refuses when the directory at the staged path is not the one readiness proved", () => {
    // Same name, new inode: whatever heartbeat appears there was not written
    // by the child readiness acknowledged.
    const staged = stagedFixture();
    rmSync(staged.dir, { recursive: true, force: true });
    mkdirSync(staged.dir, { recursive: true });
    fs.writeFileSync(join(staged.dir, "alive"), String(Date.now()));
    expect(validateStagedGeneration(staged)).toEqual({ ok: false, reason: "directory-swapped" });
  });
});
