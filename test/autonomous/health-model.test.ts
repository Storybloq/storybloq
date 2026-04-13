import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  reduceHealthState,
  collectProbes,
  deriveHealthState,
  type ProbeSnapshot,
  type HealthState,
} from "../../src/autonomous/health-model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProbes(overrides: Partial<ProbeSnapshot> = {}): ProbeSnapshot {
  return {
    alive: true,
    notEnded: true,
    mcpResponsive: true,
    guideAdvancing: true,
    agentActive: null,
    subprocessAlive: true,
    dialogClear: null,
    binaryFresh: true,
    lastMcpCallAge: 5_000,
    substageAge: 60_000,
    ...overrides,
  };
}

function writeState(sessionDir: string, state: Record<string, unknown>): void {
  writeFileSync(join(sessionDir, "state.json"), JSON.stringify(state));
}

function writeTelemetry(sessionDir: string, file: string, content: string): void {
  const tDir = join(sessionDir, "telemetry");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, file), content);
}

// ---------------------------------------------------------------------------
// Reducer tests (pure function, no I/O)
// ---------------------------------------------------------------------------

describe("reduceHealthState (pure reducer)", () => {
  it("returns 'healthy' when all probes are positive", () => {
    const probes = makeProbes({
      alive: true,
      notEnded: true,
      mcpResponsive: true,
      guideAdvancing: true,
      subprocessAlive: true,
      dialogClear: true,
      binaryFresh: true,
    });
    expect(reduceHealthState(probes)).toBe("healthy");
  });

  it("returns 'healthy' when optional probes are null (unknown)", () => {
    const probes = makeProbes({
      alive: true,
      notEnded: true,
      mcpResponsive: true,
      guideAdvancing: true,
      subprocessAlive: null,
      dialogClear: null,
      binaryFresh: null,
      agentActive: null,
    });
    expect(reduceHealthState(probes)).toBe("healthy");
  });

  it("returns 'ended' when alive is not true and notEnded is false", () => {
    const probes = makeProbes({ alive: false, notEnded: false });
    expect(reduceHealthState(probes)).toBe("ended");
  });

  it("returns 'ended' when alive is null and notEnded is false", () => {
    const probes = makeProbes({ alive: null, notEnded: false });
    expect(reduceHealthState(probes)).toBe("ended");
  });

  it("returns 'crashed' when alive is not true and notEnded is true", () => {
    const probes = makeProbes({ alive: false, notEnded: true });
    expect(reduceHealthState(probes)).toBe("crashed");
  });

  it("returns 'unknown' when alive is null and notEnded is not false", () => {
    const probes = makeProbes({ alive: null, notEnded: null });
    expect(reduceHealthState(probes)).toBe("unknown");
  });

  it("returns 'zombie' when alive but all signals silent > 30min", () => {
    const probes = makeProbes({
      alive: true,
      mcpResponsive: false,
      agentActive: false,
      subprocessAlive: false,
      guideAdvancing: false,
      lastMcpCallAge: 35 * 60 * 1000,
      substageAge: 35 * 60 * 1000,
    });
    expect(reduceHealthState(probes)).toBe("zombie");
  });

  it("does not return zombie when only one age exceeds threshold", () => {
    const probes = makeProbes({
      alive: true,
      mcpResponsive: false,
      agentActive: false,
      subprocessAlive: false,
      guideAdvancing: false,
      lastMcpCallAge: 31 * 60 * 1000,
      substageAge: 20 * 60 * 1000,
    });
    expect(reduceHealthState(probes)).not.toBe("zombie");
  });

  it("returns 'stalled' when alive + mcpResponsive but not advancing", () => {
    const probes = makeProbes({
      alive: true,
      mcpResponsive: true,
      subprocessAlive: false,
      guideAdvancing: false,
      agentActive: false,
    });
    expect(reduceHealthState(probes)).toBe("stalled");
  });

  it("returns 'waiting-on-dialog' when alive but dialog blocking", () => {
    const probes = makeProbes({
      alive: true,
      dialogClear: false,
      guideAdvancing: false,
      subprocessAlive: false,
      mcpResponsive: false,
    });
    expect(reduceHealthState(probes)).toBe("waiting-on-dialog");
  });

  it("returns 'telemetry-stale' when alive but binary drifted", () => {
    const probes = makeProbes({
      alive: true,
      binaryFresh: false,
      guideAdvancing: false,
      subprocessAlive: false,
      mcpResponsive: false,
    });
    expect(reduceHealthState(probes)).toBe("telemetry-stale");
  });

  it("returns 'waiting-on-build' when alive + subprocess but guide not advancing", () => {
    const probes = makeProbes({
      alive: true,
      subprocessAlive: true,
      guideAdvancing: false,
      mcpResponsive: false,
    });
    expect(reduceHealthState(probes)).toBe("waiting-on-build");
  });

  it("returns 'working' when alive + mcpResponsive + guideAdvancing but subprocessAlive=false", () => {
    const probes = makeProbes({
      alive: true,
      mcpResponsive: true,
      guideAdvancing: true,
      subprocessAlive: false,
    });
    expect(reduceHealthState(probes)).toBe("working");
  });

  it("returns 'unknown' when all probes are null", () => {
    const probes: ProbeSnapshot = {
      alive: null,
      notEnded: null,
      mcpResponsive: null,
      guideAdvancing: null,
      agentActive: null,
      subprocessAlive: null,
      dialogClear: null,
      binaryFresh: null,
      lastMcpCallAge: null,
      substageAge: null,
    };
    // alive is null, notEnded is null => unknown (alive=null falls through to unknown)
    expect(reduceHealthState(probes)).toBe("unknown");
  });

  // Priority tests
  it("healthy takes priority over working", () => {
    const probes = makeProbes({
      alive: true,
      notEnded: true,
      mcpResponsive: true,
      guideAdvancing: true,
      subprocessAlive: true,
      dialogClear: true,
      binaryFresh: true,
    });
    expect(reduceHealthState(probes)).toBe("healthy");
    expect(reduceHealthState(probes)).not.toBe("working");
  });

  it("zombie takes priority over stalled when both could match", () => {
    const probes = makeProbes({
      alive: true,
      mcpResponsive: false,
      agentActive: false,
      subprocessAlive: false,
      guideAdvancing: false,
      lastMcpCallAge: 35 * 60 * 1000,
      substageAge: 35 * 60 * 1000,
    });
    expect(reduceHealthState(probes)).toBe("zombie");
  });

  // Tri-state tests
  it("null subprocessAlive does not prevent healthy", () => {
    const probes = makeProbes({
      alive: true,
      notEnded: true,
      mcpResponsive: true,
      guideAdvancing: true,
      subprocessAlive: null,
      dialogClear: null,
      binaryFresh: null,
    });
    expect(reduceHealthState(probes)).toBe("healthy");
  });

  it("null dialogClear does not trigger waiting-on-dialog", () => {
    const probes = makeProbes({
      alive: true,
      dialogClear: null,
    });
    expect(reduceHealthState(probes)).not.toBe("waiting-on-dialog");
  });
});

// ---------------------------------------------------------------------------
// Probe collection tests (filesystem-backed)
// ---------------------------------------------------------------------------

describe("collectProbes", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-model-test-"));
    sessionDir = join(tmpDir, "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("alive: recent timestamp returns true", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now()));
    const probes = collectProbes(sessionDir);
    expect(probes.alive).toBe(true);
  });

  it("alive: old timestamp returns false", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now() - 60_000));
    const probes = collectProbes(sessionDir);
    expect(probes.alive).toBe(false);
  });

  it("alive: just inside threshold returns true", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now() - 29_000));
    const probes = collectProbes(sessionDir);
    expect(probes.alive).toBe(true);
  });

  it("alive: just outside threshold returns false", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now() - 31_000));
    const probes = collectProbes(sessionDir);
    expect(probes.alive).toBe(false);
  });

  it("alive: no file returns null", () => {
    rmSync(join(sessionDir, "telemetry", "alive"), { force: true });
    const probes = collectProbes(sessionDir);
    expect(probes.alive).toBe(null);
  });

  it("notEnded: no ended file returns true", () => {
    const probes = collectProbes(sessionDir);
    expect(probes.notEnded).toBe(true);
  });

  it("notEnded: ended file exists returns false", () => {
    writeTelemetry(sessionDir, "ended", "normal");
    const probes = collectProbes(sessionDir);
    expect(probes.notEnded).toBe(false);
  });

  it("mcpResponsive: recent lastMcpCall returns true", () => {
    writeTelemetry(sessionDir, "lastMcpCall", new Date().toISOString());
    const probes = collectProbes(sessionDir);
    expect(probes.mcpResponsive).toBe(true);
  });

  it("mcpResponsive: old lastMcpCall returns false", () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeTelemetry(sessionDir, "lastMcpCall", old);
    const probes = collectProbes(sessionDir);
    expect(probes.mcpResponsive).toBe(false);
  });

  it("mcpResponsive: just inside 5min threshold returns true", () => {
    const ts = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    writeTelemetry(sessionDir, "lastMcpCall", ts);
    const probes = collectProbes(sessionDir);
    expect(probes.mcpResponsive).toBe(true);
  });

  it("mcpResponsive: just outside 5min threshold returns false", () => {
    const ts = new Date(Date.now() - 5 * 60 * 1000 - 1000).toISOString();
    writeTelemetry(sessionDir, "lastMcpCall", ts);
    const probes = collectProbes(sessionDir);
    expect(probes.mcpResponsive).toBe(false);
  });

  it("mcpResponsive: no file returns null", () => {
    const probes = collectProbes(sessionDir);
    expect(probes.mcpResponsive).toBe(null);
  });

  it("guideAdvancing: recent substageStartedAt returns true", () => {
    writeState(sessionDir, {
      substageStartedAt: new Date().toISOString(),
      sessionId: "test-session",
    });
    const probes = collectProbes(sessionDir);
    expect(probes.guideAdvancing).toBe(true);
  });

  it("guideAdvancing: old substageStartedAt returns false", () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeState(sessionDir, {
      substageStartedAt: old,
      sessionId: "test-session",
    });
    const probes = collectProbes(sessionDir);
    expect(probes.guideAdvancing).toBe(false);
  });

  it("guideAdvancing: no state.json returns null", () => {
    const probes = collectProbes(sessionDir);
    expect(probes.guideAdvancing).toBe(null);
  });

  it("subprocessAlive: no subprocesses dir returns null", () => {
    const probes = collectProbes(sessionDir);
    expect(probes.subprocessAlive).toBeNull();
  });

  it("binaryFresh: null fingerprint returns null", () => {
    writeState(sessionDir, { sessionId: "test-session" });
    const probes = collectProbes(sessionDir);
    expect(probes.binaryFresh).toBe(null);
  });

  it("agentActive: always returns null (not implemented)", () => {
    const probes = collectProbes(sessionDir);
    expect(probes.agentActive).toBe(null);
  });

  // Edge cases
  it("missing telemetry directory: no crash, returns null probes", () => {
    rmSync(join(sessionDir, "telemetry"), { recursive: true, force: true });
    expect(() => collectProbes(sessionDir)).not.toThrow();
    const probes = collectProbes(sessionDir);
    expect(probes.alive).toBe(null);
    expect(probes.mcpResponsive).toBe(null);
  });

  it("corrupt state.json: no crash, returns null for state-dependent probes", () => {
    writeFileSync(join(sessionDir, "state.json"), "not valid json");
    expect(() => collectProbes(sessionDir)).not.toThrow();
    const probes = collectProbes(sessionDir);
    expect(probes.guideAdvancing).toBe(null);
    expect(probes.binaryFresh).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// deriveHealthState integration tests
// ---------------------------------------------------------------------------

describe("deriveHealthState (full derivation)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-derive-test-"));
    sessionDir = join(tmpDir, "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns HealthResult with correct structure", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now()));
    writeTelemetry(sessionDir, "lastMcpCall", new Date().toISOString());
    writeState(sessionDir, {
      sessionId: "test-session",
      substageStartedAt: new Date().toISOString(),
    });

    const result = deriveHealthState(sessionDir);
    expect(result).toHaveProperty("sessionId");
    expect(result).toHaveProperty("healthState");
    expect(result).toHaveProperty("probes");
    expect(result).toHaveProperty("derivedAt");
    expect(typeof result.healthState).toBe("string");
    expect(typeof result.derivedAt).toBe("string");
  });

  it("returns 'ended' for session with ended marker and dead sidecar", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now() - 120_000));
    writeTelemetry(sessionDir, "ended", "normal");

    const result = deriveHealthState(sessionDir);
    expect(result.healthState).toBe("ended");
  });

  it("returns 'crashed' for dead sidecar without ended marker", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now() - 120_000));

    const result = deriveHealthState(sessionDir);
    expect(result.healthState).toBe("crashed");
  });

  it("returns working-class state for active session", () => {
    writeTelemetry(sessionDir, "alive", String(Date.now()));
    writeTelemetry(sessionDir, "lastMcpCall", new Date().toISOString());
    writeState(sessionDir, {
      sessionId: "test-session",
      substageStartedAt: new Date().toISOString(),
    });

    const result = deriveHealthState(sessionDir);
    expect(["healthy", "working"]).toContain(result.healthState);
  });

  it("never throws on missing session directory", () => {
    const badDir = join(tmpDir, "nonexistent");
    expect(() => deriveHealthState(badDir)).not.toThrow();
  });
});
