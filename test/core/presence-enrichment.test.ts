import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeArrangementPresence, applyPresenceEnrichment, ownerIdentityOf } from "../../src/core/presence-enrichment.js";
import { acquireLock, releaseLock, ensurePresenceDir, readBoundedNoFollow } from "../../src/presence/io.js";
import { presenceFileBase, MAX_RECORD_BYTES } from "../../src/presence/types.js";
import { runPresenceHook } from "../../src/presence/handler.js";
import { ArrangementSchema, type Arrangement } from "../../src/models/arrangement.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "presence-enrichment-"));
  roots.push(root);
  mkdirSync(join(root, ".story"), { recursive: true });
  // `discoverProjectRootShared` (used by `runPresenceHook`) requires this to
  // recognize the directory as a project root at all.
  writeFileSync(join(root, ".story", "config.json"), "{}");
  return root;
}

function writeArrangement(root: string, overrides: Record<string, unknown> = {}): Arrangement {
  const dir = join(root, ".story", "arrangements");
  mkdirSync(dir, { recursive: true });
  const parsed = ArrangementSchema.parse({
    id: "a-0123456789abcdef",
    lifecycle: "active",
    bounds: ["T-477"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "pen-task" },
      { role: "worker", client: "claude", identityAnchor: "worker-task" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    ...overrides,
  });
  writeFileSync(join(dir, `${parsed.id}.json`), JSON.stringify(parsed));
  return parsed;
}

function writeSession(root: string, sessionId: string, state: Record<string, unknown>): void {
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    sessionId,
    status: "active",
    state: "IMPLEMENT",
    mode: "auto",
    ticket: { id: "T-020", title: "Task" },
    compactPending: false,
    ...state,
  }));
}

const PEN_TASK: OwnerTask = { client: "claude", id: "pen-task", boundAt: "2026-08-01T00:00:00Z" };

describe("computeArrangementPresence", () => {
  it("returns empty when there are no arrangements at all", () => {
    const root = makeRoot();
    expect(computeArrangementPresence(root, PEN_TASK)).toEqual({ entries: [], truncated: false });
  });

  it("finds the pen's own arrangement, role pen, worker inactive when no session matches", () => {
    const root = makeRoot();
    writeArrangement(root);
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries).toEqual([
      { arrangementId: "a-0123456789abcdef", role: "pen", lifecycle: "active", supervising: { workerActive: false } },
    ]);
  });

  it("workerActive true via the SCANNED-SESSION population (leaseState live)", () => {
    const root = makeRoot();
    writeArrangement(root);
    writeSession(root, "worker-session", {
      ownerTask: { client: "claude", id: "worker-task", boundAt: "2026-08-01T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries[0]!.supervising).toEqual({ workerActive: true });
  });

  it("workerActive false when the matching scanned session's lease has EXPIRED (scanSessionSummaries' activeSessions is already lease-filtered)", () => {
    const root = makeRoot();
    writeArrangement(root);
    writeSession(root, "worker-session-expired", {
      ownerTask: { client: "claude", id: "worker-task", boundAt: "2026-08-01T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries[0]!.supervising).toEqual({ workerActive: false });
  });

  it("workerActive true via the PRESENCE-RECORD population (dual-population liveness, section 0)", () => {
    const root = makeRoot();
    writeArrangement(root);
    // Simulate a worker's presence record with a fresh ownerIdentity match --
    // no `.story/sessions/` entry at all, the interactive-party case section
    // 0 exists to cover.
    const presDir = ensurePresenceDir(root)!;
    writeFileSync(join(presDir, "worker-interactive.json"), JSON.stringify({
      schemaVersion: 1, sessionId: "worker-interactive", generation: 1,
      startedAt: "2026-08-27T00:00:00.000Z", lastEventAt: new Date().toISOString(),
      source: "startup", openTools: [], closedToolIds: [], agentIds: [], suppressed: false, endedAt: null,
      arrangementPresence: [], arrangementPresenceTruncated: false, milestone: null,
      ownerIdentity: { client: "claude", clientTaskId: "worker-task" },
    }));
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries[0]!.supervising).toEqual({ workerActive: true });
  });

  it("a STALE presence record (lastEventAt outside PRESENCE_TTL_MS) does not count as live", () => {
    const root = makeRoot();
    writeArrangement(root);
    const presDir = ensurePresenceDir(root)!;
    writeFileSync(join(presDir, "worker-stale.json"), JSON.stringify({
      schemaVersion: 1, sessionId: "worker-stale", generation: 1,
      startedAt: "2020-01-01T00:00:00.000Z", lastEventAt: "2020-01-01T00:00:00.000Z",
      source: "startup", openTools: [], closedToolIds: [], agentIds: [], suppressed: false, endedAt: null,
      arrangementPresence: [], arrangementPresenceTruncated: false, milestone: null,
      ownerIdentity: { client: "claude", clientTaskId: "worker-task" },
    }));
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries[0]!.supervising).toEqual({ workerActive: false });
  });

  it("a TOMBSTONED presence record (endedAt set) does not count as live, even with a fresh lastEventAt", () => {
    const root = makeRoot();
    writeArrangement(root);
    const presDir = ensurePresenceDir(root)!;
    writeFileSync(join(presDir, "worker-ended.json"), JSON.stringify({
      schemaVersion: 1, sessionId: "worker-ended", generation: 1,
      startedAt: "2026-08-27T00:00:00.000Z", lastEventAt: new Date().toISOString(),
      source: "SessionEnd", openTools: [], closedToolIds: [], agentIds: [], suppressed: false,
      endedAt: new Date().toISOString(),
      arrangementPresence: [], arrangementPresenceTruncated: false, milestone: null,
      ownerIdentity: { client: "claude", clientTaskId: "worker-task" },
    }));
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries[0]!.supervising).toEqual({ workerActive: false });
  });

  it("a presence record with a FAR-FUTURE lastEventAt (corrupt or skewed) does not count as live", () => {
    const root = makeRoot();
    writeArrangement(root);
    const presDir = ensurePresenceDir(root)!;
    writeFileSync(join(presDir, "worker-future.json"), JSON.stringify({
      schemaVersion: 1, sessionId: "worker-future", generation: 1,
      startedAt: "2026-08-27T00:00:00.000Z", lastEventAt: "2099-01-01T00:00:00.000Z",
      source: "startup", openTools: [], closedToolIds: [], agentIds: [], suppressed: false, endedAt: null,
      arrangementPresence: [], arrangementPresenceTruncated: false, milestone: null,
      ownerIdentity: { client: "claude", clientTaskId: "worker-task" },
    }));
    const { entries } = computeArrangementPresence(root, PEN_TASK);
    expect(entries[0]!.supervising).toEqual({ workerActive: false });
  });

  it("a worker-role entry (this caller IS the worker) carries no supervising block", () => {
    const root = makeRoot();
    writeArrangement(root);
    const WORKER_TASK: OwnerTask = { client: "claude", id: "worker-task", boundAt: "2026-08-01T00:00:00Z" };
    const { entries } = computeArrangementPresence(root, WORKER_TASK);
    expect(entries).toEqual([
      { arrangementId: "a-0123456789abcdef", role: "worker", lifecycle: "active", supervising: null },
    ]);
  });

  it("excludes closed arrangements entirely", () => {
    const root = makeRoot();
    writeArrangement(root, { lifecycle: "closed" });
    expect(computeArrangementPresence(root, PEN_TASK)).toEqual({ entries: [], truncated: false });
  });

  it("caps at MAX_ARRANGEMENT_PRESENCE_ENTRIES (4), preferring active over suspended, then newest createdDate, and flags truncation", () => {
    const root = makeRoot();
    // Crockford base32 excludes i/l/o/u -- these tags use only safe letters.
    const activeId = (i: number) => `a-act${i}` + "0".repeat(16 - `act${i}`.length);
    const suspendedId = (i: number) => `a-spd${i}` + "0".repeat(16 - `spd${i}`.length);
    // 3 active (older to newer) + 3 suspended -- 6 total, cap keeps 4: all
    // active ones first (lifecycle priority), THEN the newest suspended one.
    for (let i = 0; i < 3; i++) {
      writeArrangement(root, {
        id: activeId(i),
        lifecycle: "active",
        createdDate: `2026-08-0${i + 1}`,
        parties: [
          { role: "pen", client: "claude", identityAnchor: "pen-task" },
          { role: "worker", client: "claude", identityAnchor: `worker-active-${i}` },
        ],
      });
    }
    for (let i = 0; i < 3; i++) {
      writeArrangement(root, {
        id: suspendedId(i),
        lifecycle: "suspended",
        createdDate: `2026-08-1${i + 1}`,
        parties: [
          { role: "pen", client: "claude", identityAnchor: "pen-task" },
          { role: "worker", client: "claude", identityAnchor: `worker-suspended-${i}` },
        ],
      });
    }
    const { entries, truncated } = computeArrangementPresence(root, PEN_TASK);
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(4);
    expect(entries.filter((e) => e.lifecycle === "active")).toHaveLength(3);
    expect(entries.filter((e) => e.lifecycle === "suspended")).toHaveLength(1);
    // The kept suspended one is the NEWEST (2026-08-13).
    expect(entries.find((e) => e.lifecycle === "suspended")!.arrangementId).toBe(suspendedId(2));
    // Output ordering: arrangementId ascending.
    const ids = entries.map((e) => e.arrangementId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("applyPresenceEnrichment", () => {
  it("creates a fresh record, tagged with the given source, when none exists yet", () => {
    const root = makeRoot();
    const outcome = applyPresenceEnrichment(root, "sess-1", 150, "status-enrichment", (base) => ({
      ...base,
      arrangementPresence: [{ arrangementId: "a-1", role: "pen", lifecycle: "active", supervising: null }],
    }));
    expect(outcome).toEqual({ status: "written" });
    const dir = ensurePresenceDir(root)!;
    const text = readBoundedNoFollow(join(dir, `${presenceFileBase("sess-1")}.json`), MAX_RECORD_BYTES)!;
    const rec = JSON.parse(text);
    expect(rec.source).toBe("status-enrichment");
    expect(rec.arrangementPresence).toHaveLength(1);
  });

  it("merges onto an EXISTING record, preserving fields the mutation does not touch", () => {
    const root = makeRoot();
    applyPresenceEnrichment(root, "sess-2", 150, "status-enrichment", (base) => ({ ...base, openTools: [{ id: "t1", tool: "Read", target: null, startedAt: "2026-08-27T00:00:00.000Z", agentId: null }] }));
    const outcome = applyPresenceEnrichment(root, "sess-2", 150, "status-enrichment", (base) => ({ ...base, ownerIdentity: ownerIdentityOf(PEN_TASK) }));
    expect(outcome).toEqual({ status: "written" });
    const dir = ensurePresenceDir(root)!;
    const rec = JSON.parse(readBoundedNoFollow(join(dir, `${presenceFileBase("sess-2")}.json`), MAX_RECORD_BYTES)!);
    expect(rec.openTools).toHaveLength(1); // preserved from the first write
    expect(rec.ownerIdentity).toEqual({ client: "claude", clientTaskId: "pen-task" });
  });

  it("skipped-no-directory when the presence directory cannot be created", () => {
    const root = makeRoot();
    // Occupy the presence path with a FILE so ensurePresenceDir's mkdir fails.
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
    writeFileSync(join(root, ".story", "telemetry", "presence"), "not a directory");
    const outcome = applyPresenceEnrichment(root, "sess-3", 150, "status-enrichment", (base) => base);
    expect(outcome).toEqual({ status: "skipped-no-directory" });
  });

  describe("both-direction lock interleaving (the highest-risk lines in this ticket)", () => {
    it("HEAVY PATH holds the lock: the hook must skip, not corrupt, and never stall past its own short budget", () => {
      const root = makeRoot();
      const sessionId = "sess-interleave-a";
      const dir = ensurePresenceDir(root)!;
      const lockPath = join(dir, `${presenceFileBase(sessionId)}.lock`);

      expect(acquireLock(lockPath)).toBe(true); // simulates the heavy path mid-write
      try {
        const outcome = runPresenceHook({
          hook_event_name: "PreToolUse", session_id: sessionId, cwd: root, tool_name: "Read", tool_use_id: "tu_1",
        });
        expect(outcome).toBe("skipped-lock-busy");
        // No record was ever created -- the hook did not partially write.
        expect(readBoundedNoFollow(join(dir, `${presenceFileBase(sessionId)}.json`), MAX_RECORD_BYTES)).toBeNull();
      } finally {
        releaseLock(lockPath);
      }
    });

    it("the HOOK holds the lock: the heavy-path enrichment call must skip, not corrupt, at ITS OWN budget", () => {
      const root = makeRoot();
      const sessionId = "sess-interleave-b";
      // Seed a real record via the hook first, so there is existing state to protect.
      runPresenceHook({ hook_event_name: "SessionStart", session_id: sessionId, cwd: root, source: "startup" });
      const dir = ensurePresenceDir(root)!;
      const recordPath = join(dir, `${presenceFileBase(sessionId)}.json`);
      const before = readBoundedNoFollow(recordPath, MAX_RECORD_BYTES);
      expect(before).not.toBeNull();

      const lockPath = join(dir, `${presenceFileBase(sessionId)}.lock`);
      expect(acquireLock(lockPath)).toBe(true); // simulates the hook mid-write
      try {
        const outcome = applyPresenceEnrichment(root, sessionId, 150, "status-enrichment", (base) => ({
          ...base,
          ownerIdentity: ownerIdentityOf(PEN_TASK),
        }));
        expect(outcome).toEqual({ status: "skipped-lock-busy" });
        // Record is byte-identical to before -- the heavy path never partially wrote.
        expect(readBoundedNoFollow(recordPath, MAX_RECORD_BYTES)).toBe(before);
      } finally {
        releaseLock(lockPath);
      }
    });

    /**
     * A real cross-process release racing a held lock cannot be simulated
     * in-process: `acquireLock`'s poll loop is deliberately fully
     * SYNCHRONOUS (`sleepSync`, no yield point), by design, exactly so a
     * single hook invocation never depends on the event loop -- so a
     * same-process `setTimeout` releasing the lock could never fire while
     * this thread is inside the busy-poll. What IS honestly testable
     * in-process is the property that actually distinguishes the two call
     * sites: the milestone command's budget is genuinely longer, not the
     * same fail-soft posture as the hook's, measured directly rather than
     * asserted from the constant alone.
     */
    it("the milestone budget is genuinely longer than the status/hook budget, measured directly against a lock that is never released", () => {
      const root = makeRoot();
      const shortLockPath = join(ensurePresenceDir(root)!, `${presenceFileBase("sess-budget-short")}.lock`);
      const longLockPath = join(ensurePresenceDir(root)!, `${presenceFileBase("sess-budget-long")}.lock`);
      expect(acquireLock(shortLockPath)).toBe(true);
      expect(acquireLock(longLockPath)).toBe(true);
      try {
        const shortStart = Date.now();
        const shortOutcome = applyPresenceEnrichment(root, "sess-budget-short", 150, "status-enrichment", (b) => b);
        const shortElapsed = Date.now() - shortStart;

        const longStart = Date.now();
        const longOutcome = applyPresenceEnrichment(root, "sess-budget-long", 750, "session-milestone", (b) => b);
        const longElapsed = Date.now() - longStart;

        expect(shortOutcome).toEqual({ status: "skipped-lock-busy" });
        expect(longOutcome).toEqual({ status: "skipped-lock-busy" });
        // Not a tight bound (CI scheduling jitter), but the ratio the two
        // constants imply (5x) must show up as a REAL difference, not just
        // as two numbers in a source file nothing exercises.
        expect(longElapsed).toBeGreaterThan(shortElapsed * 2);
      } finally {
        releaseLock(shortLockPath);
        releaseLock(longLockPath);
      }
    });

    /**
     * The ruled plan point (round-3 concurrency finding): exhausting the
     * milestone budget must surface as an explicit, machine-readable
     * retryable outcome -- never a silent "written" for a milestone that
     * was actually dropped. This is exactly `applyPresenceEnrichment`'s
     * `"skipped-lock-busy"` outcome; the milestone COMMAND (built on top of
     * this function) is responsible for turning that into a retryable
     * error response rather than a success, which its own tests assert.
     */
    it("an exhausted milestone-length budget reports skipped-lock-busy explicitly, never written", () => {
      const root = makeRoot();
      const lockPath = join(ensurePresenceDir(root)!, `${presenceFileBase("sess-exhausted")}.lock`);
      expect(acquireLock(lockPath)).toBe(true);
      try {
        const outcome = applyPresenceEnrichment(root, "sess-exhausted", 750, "session-milestone", (base) => ({
          ...base,
          milestone: { kind: "implementing", at: new Date().toISOString() },
        }));
        expect(outcome).toEqual({ status: "skipped-lock-busy" });
        expect(outcome).not.toEqual({ status: "written" });
      } finally {
        releaseLock(lockPath);
      }
    });
  });
});
