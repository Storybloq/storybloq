/**
 * ISS-1012: the status writers must not rewrite an unchanged status.json.
 *
 * The Stop hook fires at every turn end and the write was unconditional, so a
 * host project's tree changed (temp file + rename, new inode) on every turn with
 * nothing to report. A field node's conformance harness treats any write during
 * a test battery as a failure, so a background battery whose invoking turn ended
 * mid-run tripped its isolation fence deterministically.
 *
 * These tests pin the gate's two dangerous directions separately. A FALSE SKIP
 * (real change never reaches the file) is the harmful one and gets the bulk of
 * the coverage; a false write is merely today's behavior and is the fail-open
 * default for every uncertainty.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
  mkdtempSync,
  symlinkSync,
  lstatSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import {
  writeStatusFile,
  statusPayloadsEquivalent,
  refreshStatusForSession,
} from "../../src/autonomous/status-writer.js";
import { activePayload, handleHookStatus } from "../../src/cli/commands/hook-status.js";
import { isStopHookStatusWriteEnabled } from "../../src/core/limit-config.js";
import { buildActivePayload } from "../../src/autonomous/status-payload.js";
import type { StatusPayload, StatusPayloadActive } from "../../src/autonomous/session-types.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeSessionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    state: "IMPLEMENT",
    status: "active",
    ticket: { id: "T-100", title: "Test ticket", risk: "low" },
    git: { branch: "test-branch" },
    ...overrides,
  };
}

/** Identity of the file as consumers' watchers see it: a rename bumps ino even when bytes match. */
function fileIdentity(path: string): string {
  const s = statSync(path);
  return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`;
}

/**
 * A session state that findActiveSessionMinimal actually accepts: the strict
 * schema requires schemaVersion/recipe/revision, and the scan additionally
 * demands status "active" plus an unexpired lease. A fixture missing any of
 * these is silently skipped, which turns any test that depends on the hook
 * finding a session into one that cannot fail.
 */
function makeDiscoverableSessionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recipe: "coding",
    revision: 1,
    startedAt: new Date().toISOString(),
    lastGuideCall: new Date().toISOString(),
    lease: {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      lastHeartbeat: new Date().toISOString(),
    },
    contextPressure: { level: "low" },
    ...makeSessionState(overrides),
  };
}

function payloadFor(state: Record<string, unknown>, extra: Parameters<typeof buildActivePayload>[1] = {}): StatusPayload {
  return { ...buildActivePayload(state as never, extra), lastWrittenBy: "hook" } as StatusPayload;
}

function stripVolatile(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed.observedAt;
  delete parsed.lastWrittenBy;
  return parsed;
}

describe("ISS-1012 status.json content gate", () => {
  let tmpDir: string;
  let root: string;
  let sessionDir: string;
  let statusPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "iss1012-gate-"));
    root = join(tmpDir, "project");
    sessionDir = join(root, ".story", "sessions", SESSION_ID);
    statusPath = join(root, ".story", "status.json");
    mkdirSync(join(root, ".story"), { recursive: true });
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Live telemetry drives the health reducer to "healthy" -- a fixture without it probes to "unknown". */
  function writeLiveTelemetry(): void {
    const telemetryDir = join(sessionDir, "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(join(telemetryDir, "alive"), String(Date.now()), "utf-8");
    writeFileSync(join(telemetryDir, "lastMcpCall"), new Date().toISOString(), "utf-8");
  }

  // ── The skip itself ─────────────────────────────────────────────

  describe("skips a rewrite of unchanged content", () => {
    it("second identical write leaves inode AND mtime untouched, still returning true", () => {
      const payload = payloadFor(makeSessionState());
      expect(writeStatusFile(root, payload)).toBe(true);
      const before = fileIdentity(statusPath);

      // The next turn's hook builds a fresh payload whose observedAt is a NEW
      // stamp. Set it explicitly rather than relying on two back-to-back
      // `new Date()` calls landing in different milliseconds -- they usually do
      // not, and a clock-resolution race here would flake the one test that
      // pins the change's core behavior.
      const next = payloadFor(makeSessionState()) as StatusPayloadActive & { observedAt: string };
      next.observedAt = new Date(Date.parse((payload as StatusPayloadActive).observedAt) + 60_000).toISOString();
      expect(next.observedAt).not.toBe((payload as StatusPayloadActive).observedAt);

      expect(writeStatusFile(root, next as StatusPayload)).toBe(true);
      expect(fileIdentity(statusPath)).toBe(before);
    });

    it("skips when only lastWrittenBy differs (the hook/guide alternation)", () => {
      const state = makeSessionState();
      expect(writeStatusFile(root, payloadFor(state))).toBe(true);
      const before = fileIdentity(statusPath);

      const asGuide = { ...buildActivePayload(state as never, {}), lastWrittenBy: "guide" } as StatusPayload;
      expect(writeStatusFile(root, asGuide)).toBe(true);
      expect(fileIdentity(statusPath)).toBe(before);
    });

    it("skips an inactive payload rewrite (the dominant no-session case)", () => {
      const ended = makeSessionState({ status: "completed", state: "SESSION_END" });
      expect(refreshStatusForSession(root, sessionDir, ended as never, "hook")).toBe(true);
      const before = fileIdentity(statusPath);

      expect(refreshStatusForSession(root, sessionDir, ended as never, "guide")).toBe(true);
      expect(fileIdentity(statusPath)).toBe(before);
    });

    it("skips when runningSubprocesses holds the same set in a different order", () => {
      const a = { pid: 111, category: "agent", startedAt: "2026-08-16T00:00:00.000Z", stage: "IMPLEMENT" };
      const b = { pid: 222, category: "build", startedAt: "2026-08-16T00:00:01.000Z", stage: "TEST" };
      expect(writeStatusFile(root, payloadFor(makeSessionState(), { runningSubprocesses: [a, b] }))).toBe(true);
      const before = fileIdentity(statusPath);

      expect(writeStatusFile(root, payloadFor(makeSessionState(), { runningSubprocesses: [b, a] }))).toBe(true);
      expect(fileIdentity(statusPath)).toBe(before);
    });
  });

  // ── False-skip guards: every real change must still reach the file ──

  describe("writes when anything reader-visible changed", () => {
    const cases: Array<[string, Parameters<typeof buildActivePayload>[1]]> = [
      ["lastMcpCall", { lastMcpCall: "2026-08-16T10:00:00.000Z" }],
      ["healthState", { healthState: "stalled" }],
      ["alive", { alive: false }],
      ["runningSubprocesses", { runningSubprocesses: [{ pid: 9, category: "agent", startedAt: "x", stage: "y" }] }],
    ];

    for (const [label, extra] of cases) {
      it(`writes on a ${label} change`, () => {
        expect(writeStatusFile(root, payloadFor(makeSessionState(), {
          lastMcpCall: null, healthState: "healthy", alive: true, runningSubprocesses: null,
        }))).toBe(true);
        const before = fileIdentity(statusPath);

        expect(writeStatusFile(root, payloadFor(makeSessionState(), {
          lastMcpCall: null, healthState: "healthy", alive: true, runningSubprocesses: null, ...extra,
        }))).toBe(true);
        expect(fileIdentity(statusPath)).not.toBe(before);
      });
    }

    it("writes on a workflow state transition", () => {
      expect(writeStatusFile(root, payloadFor(makeSessionState({ state: "PLAN" })))).toBe(true);
      const before = fileIdentity(statusPath);

      expect(writeStatusFile(root, payloadFor(makeSessionState({ state: "IMPLEMENT" })))).toBe(true);
      expect(fileIdentity(statusPath)).not.toBe(before);
      expect(JSON.parse(readFileSync(statusPath, "utf-8")).state).toBe("IMPLEMENT");
    });

    it("writes when the payload flips active -> inactive", () => {
      expect(refreshStatusForSession(root, sessionDir, makeSessionState() as never, "guide")).toBe(true);
      const before = fileIdentity(statusPath);

      const ended = makeSessionState({ status: "completed", state: "SESSION_END" });
      expect(refreshStatusForSession(root, sessionDir, ended as never, "guide")).toBe(true);
      expect(fileIdentity(statusPath)).not.toBe(before);
      expect(JSON.parse(readFileSync(statusPath, "utf-8")).sessionActive).toBe(false);
    });
  });

  // ── Fail open: an unusable previous value is rewritten, never preserved ──

  describe("fails open to a write", () => {
    const unparseable: Array<[string, string]> = [
      ["corrupt JSON", "{not json"],
      ["truncated JSON", '{"schemaVersion": 1, "sessionAct'],
      ["a JSON array", "[]"],
      ["a JSON scalar", '"nope"'],
      ["an empty file", ""],
    ];

    for (const [label, contents] of unparseable) {
      it(`rewrites over ${label}`, () => {
        writeFileSync(statusPath, contents, "utf-8");
        const payload = payloadFor(makeSessionState());
        expect(writeStatusFile(root, payload)).toBe(true);
        const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
        expect(parsed.sessionActive).toBe(true);
        expect(parsed.state).toBe("IMPLEMENT");
      });
    }

    // Each of these starts from a payload that WOULD be judged equivalent and
    // corrupts exactly one field, so the only thing that can force the write is
    // the validation being named. Built the other way round -- an inactive stub
    // for an active payload -- the discriminator mismatch rejects them all on
    // its own and the named check is never reached.
    const corrupted: Array<[string, (equivalent: Record<string, unknown>) => void]> = [
      ["a previous value whose schemaVersion is wrong", (p) => { p.schemaVersion = 99; }],
      ["a previous value whose schemaVersion is missing", (p) => { delete p.schemaVersion; }],
      ["a previous value whose sessionActive is not a boolean", (p) => { p.sessionActive = "yes"; }],
      ["a previous value whose lastWrittenBy is not a known writer", (p) => { p.lastWrittenBy = 7; }],
      ["a previous value whose lastWrittenBy is an unknown string", (p) => { p.lastWrittenBy = "mac-app"; }],
      ["a previous value whose observedAt is empty", (p) => { p.observedAt = ""; }],
      ["a previous value whose observedAt is not a string", (p) => { p.observedAt = 1_700_000_000; }],
    ];

    for (const [label, corrupt] of corrupted) {
      it(`rewrites over ${label}`, () => {
        const payload = payloadFor(makeSessionState());
        const previous = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
        // Sanity: untouched, this previous value IS equivalent -- so any write
        // below is caused by the corruption and nothing else.
        expect(statusPayloadsEquivalent(payload, JSON.stringify(previous))).toBe(true);

        corrupt(previous);
        expect(statusPayloadsEquivalent(payload, JSON.stringify(previous))).toBe(false);

        writeFileSync(statusPath, JSON.stringify(previous, null, 2) + "\n", "utf-8");
        const before = fileIdentity(statusPath);
        expect(writeStatusFile(root, payload)).toBe(true);
        expect(fileIdentity(statusPath)).not.toBe(before);
      });
    }

    it("heals an active payload missing observedAt instead of preserving it forever", () => {
      // The trap the shape validation exists for: observedAt is EXCLUDED from
      // the comparison, so without validating the previous value first, a
      // payload missing it compares equal and the defect is never repaired.
      const payload = payloadFor(makeSessionState());
      const withoutObservedAt = { ...(payload as Record<string, unknown>) };
      delete withoutObservedAt.observedAt;
      writeFileSync(statusPath, JSON.stringify(withoutObservedAt, null, 2) + "\n", "utf-8");

      expect(writeStatusFile(root, payload)).toBe(true);
      expect(typeof JSON.parse(readFileSync(statusPath, "utf-8")).observedAt).toBe("string");
    });

    it("rewrites over an oversized previous file", () => {
      writeFileSync(statusPath, "x".repeat(300 * 1024), "utf-8");
      expect(writeStatusFile(root, payloadFor(makeSessionState()))).toBe(true);
      expect(JSON.parse(readFileSync(statusPath, "utf-8")).sessionActive).toBe(true);
    });

    it("never throws when .story/ does not exist", () => {
      const missing = join(tmpDir, "no-such-project");
      expect(() => writeStatusFile(missing, payloadFor(makeSessionState()))).not.toThrow();
      expect(writeStatusFile(missing, payloadFor(makeSessionState()))).toBe(false);
    });
  });

  // ── Generated-artifact symlink policy ───────────────────────────

  describe("symlink at status.json", () => {
    it("replaces an EQUIVALENT symlinked status.json with a regular file, leaving the target intact", () => {
      // A symlink here is a defect the unconditional rename used to heal. A gate
      // that compared through the link would instead preserve externally
      // controlled content behind an equivalence skip -- and keep feeding it to
      // Mac, websocket and CloudKit consumers.
      const payload = payloadFor(makeSessionState());
      const outside = join(tmpDir, "planted.json");
      writeFileSync(outside, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      symlinkSync(outside, statusPath);
      expect(lstatSync(statusPath).isSymbolicLink()).toBe(true);

      expect(writeStatusFile(root, payload)).toBe(true);

      expect(lstatSync(statusPath).isSymbolicLink()).toBe(false);
      expect(statSync(statusPath).isFile()).toBe(true);
      // The planted target keeps its own content: we replaced the entry, not it.
      expect(existsSync(outside)).toBe(true);
      expect(JSON.parse(readFileSync(outside, "utf-8")).sessionActive).toBe(true);
    });
  });

  // ── Concurrency posture (no lock, deliberately) ─────────────────

  describe("a skip performs no write at all", () => {
    it("leaves a concurrently-replaced equivalent file exactly as the other writer left it", () => {
      // Characterizes the no-lock decision: the only interleaving the gate
      // changes is "the other writer replaced the file between our read and our
      // decision", and skipping LEAVES THEIR FILE -- where the unconditional
      // write would have clobbered it with ours. Deterministic, no spies.
      const payload = payloadFor(makeSessionState());
      expect(writeStatusFile(root, payload)).toBe(true);

      const others = join(tmpDir, "other-writer.json");
      writeFileSync(others, JSON.stringify({ ...(payload as object), lastWrittenBy: "guide" }, null, 2) + "\n", "utf-8");
      renameSync(others, statusPath);
      const theirIdentity = fileIdentity(statusPath);

      expect(writeStatusFile(root, payloadFor(makeSessionState()))).toBe(true);
      expect(fileIdentity(statusPath)).toBe(theirIdentity);
      expect(JSON.parse(readFileSync(statusPath, "utf-8")).lastWrittenBy).toBe("guide");
    });
  });

  // ── statusPayloadsEquivalent: purity + canonicalization ─────────

  describe("statusPayloadsEquivalent", () => {
    it("does not mutate the caller's payload", () => {
      const entries = [
        { pid: 222, category: "build", startedAt: "b", stage: "TEST" },
        { pid: 111, category: "agent", startedAt: "a", stage: "IMPLEMENT" },
      ];
      const payload = payloadFor(makeSessionState(), { runningSubprocesses: entries });
      const snapshot = JSON.stringify(payload);

      statusPayloadsEquivalent(payload, JSON.stringify(payload));

      expect(JSON.stringify(payload)).toBe(snapshot);
      expect((payload as StatusPayloadActive).runningSubprocesses?.[0]?.pid).toBe(222);
    });

    it("orders subprocesses deterministically when pids collide", () => {
      const x = { pid: 5, category: "agent", startedAt: "2026-01-01T00:00:00Z", stage: "IMPLEMENT" };
      const y = { pid: 5, category: "build", startedAt: "2026-01-01T00:00:00Z", stage: "TEST" };
      const one = payloadFor(makeSessionState(), { runningSubprocesses: [x, y] });
      const two = payloadFor(makeSessionState(), { runningSubprocesses: [y, x] });
      expect(statusPayloadsEquivalent(one, JSON.stringify(two))).toBe(true);
    });

    it("preserves duplicate multiplicity (a dropped duplicate is a real change)", () => {
      const dup = { pid: 5, category: "agent", startedAt: "t", stage: "IMPLEMENT" };
      const twice = payloadFor(makeSessionState(), { runningSubprocesses: [dup, dup] });
      const once = payloadFor(makeSessionState(), { runningSubprocesses: [dup] });
      expect(statusPayloadsEquivalent(twice, JSON.stringify(once))).toBe(false);
    });

    it("is key-order independent", () => {
      const payload = payloadFor(makeSessionState());
      const reordered = Object.fromEntries(Object.entries(payload as object).reverse());
      expect(statusPayloadsEquivalent(payload, JSON.stringify(reordered))).toBe(true);
    });
  });

  // ── 1b: the two writers must agree, or the gate can never skip ──

  describe("cross-writer payload equivalence", () => {
    const leaseVariants: Array<[string, Record<string, unknown>]> = [
      ["no lease", {}],
      ["live lease", { lease: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }],
      ["expired lease", { lease: { expiresAt: new Date(Date.now() - 3_600_000).toISOString() } }],
      ["malformed lease", { lease: { expiresAt: "not-a-date" } }],
    ];

    for (const [label, leaseOverride] of leaseVariants) {
      it(`hook and guide agree on every field with ${label}`, () => {
        const state = makeSessionState(leaseOverride);
        // Guide path writes the file; hook path builds its payload in memory.
        expect(refreshStatusForSession(root, sessionDir, state as never, "guide")).toBe(true);
        const fromGuide = stripVolatile(readFileSync(statusPath, "utf-8"));
        const fromHook = stripVolatile(JSON.stringify(activePayload(state as never, root)));

        expect(fromGuide).toEqual(fromHook);
      });
    }

    it("hook and guide agree with telemetry present (heartbeat + lastMcpCall + subprocesses)", () => {
      writeLiveTelemetry();

      const state = makeSessionState();
      expect(refreshStatusForSession(root, sessionDir, state as never, "guide")).toBe(true);
      const fromGuide = stripVolatile(readFileSync(statusPath, "utf-8"));
      const fromHook = stripVolatile(JSON.stringify(activePayload(state as never, root)));

      expect(fromGuide).toEqual(fromHook);
    });

    it("the guide emits the REAL computed verdict, not a constant", () => {
      // Nothing assigns session.healthState, so before ISS-1012 the guide always
      // wrote null over whatever the hook had computed: the file flapped, and no
      // content gate could ever skip during an active session.
      //
      // The fixture matters as much as the assertion. A bare session probes to
      // "unknown", which is also what a hardcoded constant would produce -- so
      // this writes live telemetry, which drives the reducer to "healthy". Any
      // stand-in constant now fails, not just a null.
      writeLiveTelemetry();
      const state = makeSessionState();
      expect(refreshStatusForSession(root, sessionDir, state as never, "guide")).toBe(true);
      const written = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive;

      expect(written.healthState).toBe("healthy");
      expect(written.healthState).toBe((activePayload(state as never, root) as StatusPayloadActive).healthState);
    });

    it("degrades with the session: no telemetry probes to a different verdict than live telemetry", () => {
      // The pair is what proves the value is DERIVED. One fixture pinned to one
      // constant could be satisfied by that constant; two fixtures that must
      // disagree cannot.
      const state = makeSessionState();
      expect(refreshStatusForSession(root, sessionDir, state as never, "guide")).toBe(true);
      const withoutTelemetry = (JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive).healthState;

      writeLiveTelemetry();
      expect(refreshStatusForSession(root, sessionDir, state as never, "guide")).toBe(true);
      const withTelemetry = (JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive).healthState;

      expect(withoutTelemetry).toBe("unknown");
      expect(withTelemetry).toBe("healthy");
    });

    it("alternating hook and guide writes over one unchanged session write the file exactly once", () => {
      const state = makeSessionState();
      expect(refreshStatusForSession(root, sessionDir, state as never, "hook")).toBe(true);
      const before = fileIdentity(statusPath);

      for (const writer of ["guide", "hook", "guide", "hook"] as const) {
        expect(refreshStatusForSession(root, sessionDir, state as never, writer)).toBe(true);
      }

      expect(fileIdentity(statusPath)).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// The Stop-hook opt-out
// ---------------------------------------------------------------------------

describe("ISS-1012 statusWriter.stopHook opt-out", () => {
  let tmpDir: string;
  let root: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "iss1012-flag-"));
    root = join(tmpDir, "project");
    configPath = join(root, ".story", "config.json");
    mkdirSync(join(root, ".story"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(value: unknown): void {
    writeFileSync(configPath, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf-8");
  }

  it("disables only on an explicit false", () => {
    writeConfig({ version: 1, statusWriter: { stopHook: false } });
    expect(isStopHookStatusWriteEnabled(root)).toBe(false);
  });

  it("stays enabled for every uncertainty", () => {
    // A broken config must never silently blind the Mac app: the writer is the
    // only source of the session id the telemetry watcher and iOS transcript
    // bootstrap from, so every unreadable case fails ENABLED.
    const enabledCases: Array<[string, unknown]> = [
      ["no config file at all", null],
      ["config without statusWriter", { version: 1 }],
      ["statusWriter without stopHook", { version: 1, statusWriter: {} }],
      ["stopHook: true", { version: 1, statusWriter: { stopHook: true } }],
      ["stopHook as the string 'false'", { version: 1, statusWriter: { stopHook: "false" } }],
      ["stopHook null", { version: 1, statusWriter: { stopHook: null } }],
      ["statusWriter as a non-object", { version: 1, statusWriter: "off" }],
      ["statusWriter as an array", { version: 1, statusWriter: [] }],
      ["malformed JSON", "{ not json"],
      ["empty file", ""],
      ["a JSON array document", "[]"],
    ];

    for (const [label, value] of enabledCases) {
      rmSync(configPath, { force: true });
      if (value !== null) writeConfig(value);
      expect(isStopHookStatusWriteEnabled(root), label).toBe(true);
    }
  });

  it("honors a legitimately symlinked config (user input, unlike the generated status file)", () => {
    const real = join(tmpDir, "real-config.json");
    writeFileSync(real, JSON.stringify({ version: 1, statusWriter: { stopHook: false } }), "utf-8");
    symlinkSync(real, configPath);
    expect(isStopHookStatusWriteEnabled(root)).toBe(false);
  });

  it("falls back to enabled on a broken symlink", () => {
    symlinkSync(join(tmpDir, "does-not-exist.json"), configPath);
    expect(isStopHookStatusWriteEnabled(root)).toBe(true);
  });

  it("falls back to enabled on an oversized config", () => {
    writeFileSync(configPath, `{"version":1,"pad":"${"x".repeat(300 * 1024)}","statusWriter":{"stopHook":false}}`, "utf-8");
    expect(isStopHookStatusWriteEnabled(root)).toBe(true);
  });

  /**
   * Plant a subprocess record for a pid that cannot be running, at the path the
   * registry actually reaps: `<sessionDir>/telemetry/subprocesses/`. Planted
   * anywhere else -- notably `<sessionDir>/subprocesses/` -- nothing ever reads
   * it, and an "it survived" assertion passes in every world.
   */
  function plantDeadSubprocessRecord(sessionDir: string): string {
    const registry = join(sessionDir, "telemetry", "subprocesses");
    mkdirSync(registry, { recursive: true });
    const record = join(registry, "2147483646.json");
    writeFileSync(record, JSON.stringify({
      pid: 2_147_483_646, category: "agent", startedAt: "2026-08-16T00:00:00.000Z", stage: "IMPLEMENT",
    }), "utf-8");
    return record;
  }

  function seedDiscoverableSession(): string {
    const sessionDir = join(root, ".story", "sessions", SESSION_ID);
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify(makeDiscoverableSessionState()), "utf-8");
    return sessionDir;
  }

  it("reaps a stale subprocess record when enabled -- the control that makes the next test mean something", async () => {
    // Without this positive control, "the record survived" proves nothing: it
    // survives just as well when the hook never had a session to collect from.
    const sessionDir = seedDiscoverableSession();
    const deadRecord = plantDeadSubprocessRecord(sessionDir);
    writeConfig({ version: 1 });

    await captureStopHook({ cwd: root, session_id: "test-task" });

    const status = JSON.parse(readFileSync(join(root, ".story", "status.json"), "utf-8"));
    expect(status.sessionActive).toBe(true);   // the session really was discovered
    expect(existsSync(deadRecord)).toBe(false); // ... and collection really did reap
  });

  it("makes the Stop hook mutate NOTHING -- no status file, no gitignore heal, no subprocess reaping", async () => {
    // The check sits before payload COLLECTION, not at the write: building the
    // payload reaps stale subprocess records, so a check at the write would
    // still have mutated .story/ on a node that asked for no writes at all.
    const sessionDir = seedDiscoverableSession();
    const deadRecord = plantDeadSubprocessRecord(sessionDir);
    writeConfig({ version: 1, statusWriter: { stopHook: false } });

    await captureStopHook({ cwd: root, session_id: "test-task" });

    expect(existsSync(join(root, ".story", "status.json"))).toBe(false);
    expect(existsSync(join(root, ".story", ".gitignore"))).toBe(false);
    expect(existsSync(deadRecord)).toBe(true);
  });

  it("writes normally when the flag is absent", async () => {
    writeConfig({ version: 1 });
    await captureStopHook({ cwd: root, session_id: "test-task" });
    expect(existsSync(join(root, ".story", "status.json"))).toBe(true);
    expect(existsSync(join(root, ".story", ".gitignore"))).toBe(true);
  });
});

// handleHookStatus calls process.exit at every return; this sentinel unwinds it
// without killing the vitest process (the deletion-evidence.test.ts harness).
class ExitSignal extends Error {
  constructor(readonly code?: number) {
    super("exit");
  }
}

async function captureStopHook(input: Record<string, unknown>): Promise<void> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stream = Readable.from([JSON.stringify(input)]) as unknown as NodeJS.ReadStream;
  (stream as { isTTY?: boolean }).isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  (process.stdout.write as unknown) = () => true;
  (process.stderr.write as unknown) = () => true;
  (process.exit as unknown) = ((code?: number) => { throw new ExitSignal(code); }) as never;
  try {
    await handleHookStatus({});
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    (process.exit as unknown) = origExit;
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
}
