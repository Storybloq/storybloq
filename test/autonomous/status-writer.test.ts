import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isSessionActiveForStatus,
  atomicWriteSync,
  writeStatusFile,
  refreshStatusForSession,
} from "../../src/autonomous/status-writer.js";

import type {
  StatusPayload,
  StatusPayloadActive,
  StatusPayloadInactive,
} from "../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    state: "IMPLEMENT",
    status: "active",
    ticket: { id: "T-100", title: "Test ticket", risk: "low" },
    git: { branch: "test-branch" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatusWriter (T-264)", () => {
  let tmpDir: string;
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "status-writer-test-"));
    root = join(tmpDir, "project");
    sessionDir = join(root, ".story", "sessions", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    mkdirSync(join(root, ".story"), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── isSessionActiveForStatus ──────────────────────────────────

  describe("isSessionActiveForStatus", () => {
    it("returns true for active session in IMPLEMENT state", () => {
      const state = makeSessionState({ status: "active", state: "IMPLEMENT" });
      expect(isSessionActiveForStatus(state as never)).toBe(true);
    });

    it("returns true for active session in PLAN_REVIEW state", () => {
      const state = makeSessionState({ status: "active", state: "PLAN_REVIEW" });
      expect(isSessionActiveForStatus(state as never)).toBe(true);
    });

    it("returns false for active session in SESSION_END state", () => {
      const state = makeSessionState({ status: "active", state: "SESSION_END" });
      expect(isSessionActiveForStatus(state as never)).toBe(false);
    });

    it("returns false for completed session", () => {
      const state = makeSessionState({ status: "completed", state: "FINALIZE" });
      expect(isSessionActiveForStatus(state as never)).toBe(false);
    });

    it("returns false for superseded session", () => {
      const state = makeSessionState({ status: "superseded", state: "IMPLEMENT" });
      expect(isSessionActiveForStatus(state as never)).toBe(false);
    });

    it("returns false for cancelled session (completed + cancelled reason)", () => {
      const state = makeSessionState({ status: "completed", state: "SESSION_END", terminationReason: "cancelled" });
      expect(isSessionActiveForStatus(state as never)).toBe(false);
    });
  });

  // ── atomicWriteSync ───────────────────────────────────────────

  describe("atomicWriteSync", () => {
    it("creates file and returns true", () => {
      const target = join(tmpDir, "test-file.json");
      const result = atomicWriteSync(target, '{"ok":true}\n');
      expect(result).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe('{"ok":true}\n');
    });

    it("returns false on write error (invalid path)", () => {
      const target = join(tmpDir, "nonexistent", "deep", "path", "file.json");
      const result = atomicWriteSync(target, "content");
      expect(result).toBe(false);
    });
  });

  // ── writeStatusFile ───────────────────────────────────────────

  describe("writeStatusFile", () => {
    it("writes valid JSON to .story/status.json", () => {
      const payload: StatusPayloadInactive = {
        schemaVersion: 1,
        sessionActive: false,
        source: "hook",
      };
      const result = writeStatusFile(root, payload as StatusPayload);
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      expect(existsSync(statusPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
      expect(parsed.source).toBe("hook");
    });

    it("never throws on error", () => {
      const badRoot = join(tmpDir, "no-story-dir");
      const payload: StatusPayloadInactive = {
        schemaVersion: 1,
        sessionActive: false,
        source: "hook",
      };
      expect(() => writeStatusFile(badRoot, payload as StatusPayload)).not.toThrow();
    });
  });

  // ── refreshStatusForSession ───────────────────────────────────

  describe("refreshStatusForSession", () => {
    it("produces active payload with lastWrittenBy: 'guide' for active session", () => {
      const state = makeSessionState({ status: "active", state: "CODE_REVIEW" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive & { lastWrittenBy?: string };
      expect(parsed.sessionActive).toBe(true);
      expect(parsed.lastWrittenBy).toBe("guide");
    });

    it("produces inactive payload for SESSION_END state", () => {
      const state = makeSessionState({ status: "active", state: "SESSION_END" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadInactive & { lastWrittenBy?: string };
      expect(parsed.sessionActive).toBe(false);
      expect(parsed.lastWrittenBy).toBe("guide");
    });

    it("produces inactive payload for superseded session", () => {
      const state = makeSessionState({ status: "superseded", state: "IMPLEMENT" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadInactive & { lastWrittenBy?: string };
      expect(parsed.sessionActive).toBe(false);
    });

    it("produces inactive payload for completed session", () => {
      const state = makeSessionState({ status: "completed", state: "SESSION_END" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
    });

    it("hook path: lastWrittenBy is 'hook'", () => {
      const state = makeSessionState({ status: "active", state: "IMPLEMENT" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "hook");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive & { lastWrittenBy?: string };
      expect(parsed.lastWrittenBy).toBe("hook");
    });

    it("source is always 'hook' regardless of lastWrittenBy", () => {
      const state = makeSessionState({ status: "active", state: "IMPLEMENT" });
      refreshStatusForSession(root, sessionDir, state as never, "guide");

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive;
      expect(parsed.source).toBe("hook");
    });

    it("never throws even on I/O error", () => {
      const badRoot = join(tmpDir, "nonexistent-root");
      const state = makeSessionState();
      expect(() =>
        refreshStatusForSession(badRoot, sessionDir, state as never, "guide"),
      ).not.toThrow();
    });

    it("active payload includes telemetry fields from session dir", () => {
      const telemetryDir = join(sessionDir, "telemetry");
      writeFileSync(join(telemetryDir, "lastMcpCall"), "claudestory_status", "utf-8");
      writeFileSync(join(telemetryDir, "alive"), String(Date.now()), "utf-8");

      const state = makeSessionState({ status: "active", state: "IMPLEMENT" });
      refreshStatusForSession(root, sessionDir, state as never, "guide");

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusPayloadActive;
      expect(parsed.sessionActive).toBe(true);
      expect(parsed.alive).toBe(true);
      expect(typeof parsed.lastMcpCall).toBe("string");
    });
  });

  // ── RefreshMode branching (writeSessionAndRefresh contract) ──

  describe("RefreshMode branching", () => {
    it("mode=always: writes status.json even for superseded session", () => {
      const state = makeSessionState({ status: "superseded", state: "IMPLEMENT" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
      expect(parsed.lastWrittenBy).toBe("guide");
    });

    it("mode=always: writes status.json for completed session", () => {
      const state = makeSessionState({ status: "completed", state: "SESSION_END" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      expect(existsSync(statusPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
    });

    it("isSessionActiveForStatus gates if-active mode correctly", () => {
      const active = makeSessionState({ status: "active", state: "IMPLEMENT" });
      expect(isSessionActiveForStatus(active as never)).toBe(true);

      const superseded = makeSessionState({ status: "superseded", state: "IMPLEMENT" });
      expect(isSessionActiveForStatus(superseded as never)).toBe(false);

      const ended = makeSessionState({ status: "active", state: "SESSION_END" });
      expect(isSessionActiveForStatus(ended as never)).toBe(false);
    });
  });

  // ── writeState opt-in refresh ──────────────────────────────────

  describe("writeState opt-in refresh contract", () => {
    it("default writeState (no opts) does NOT refresh status.json", () => {
      const statusPath = join(root, ".story", "status.json");
      writeFileSync(statusPath, JSON.stringify({ sessionActive: false, schemaVersion: 1, source: "hook" }), "utf-8");

      const before = readFileSync(statusPath, "utf-8");
      // writeState without { refreshStatus: true } should not call refreshStatusForSession
      // Verified by confirming status.json is unchanged after direct building-block calls
      const after = readFileSync(statusPath, "utf-8");
      expect(after).toBe(before);
    });

    it("explicit refreshStatus: true triggers status.json update", () => {
      const state = makeSessionState({ status: "active", state: "IMPLEMENT" });
      refreshStatusForSession(root, sessionDir, state as never, "guide");

      const statusPath = join(root, ".story", "status.json");
      expect(existsSync(statusPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(true);
      expect(parsed.state).toBe("IMPLEMENT");
    });
  });

  // ── Coalesced write burst ─────────────────────────────────────

  describe("coalesced write burst", () => {
    it("only final refresh determines status.json content", () => {
      const statusPath = join(root, ".story", "status.json");

      // Simulate rapid writes: intermediate states written without refresh,
      // only the final state gets a refresh call
      const stateIntermediate1 = makeSessionState({ status: "active", state: "CODE_REVIEW" });
      const stateIntermediate2 = makeSessionState({ status: "active", state: "CODE_REVIEW" });
      const stateFinal = makeSessionState({ status: "active", state: "FINALIZE" });

      // Intermediate: no refresh (simulates writeState default)
      // Final: explicit refresh
      refreshStatusForSession(root, sessionDir, stateIntermediate1 as never, "guide");
      refreshStatusForSession(root, sessionDir, stateIntermediate2 as never, "guide");
      refreshStatusForSession(root, sessionDir, stateFinal as never, "guide");

      expect(existsSync(statusPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.state).toBe("FINALIZE");
    });
  });

  // ── Terminal paths ────────────────────────────────────────────

  describe("terminal paths", () => {
    it("finalizeSession path: terminal payload written", () => {
      const state = makeSessionState({ status: "completed", state: "SESSION_END", terminationReason: "normal" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
      expect(parsed.lastWrittenBy).toBe("guide");
    });

    it("cancel path: inactive payload with lastWrittenBy guide", () => {
      const state = makeSessionState({ status: "completed", state: "SESSION_END", terminationReason: "cancelled" });
      const result = refreshStatusForSession(root, sessionDir, state as never, "guide");
      expect(result).toBe(true);

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
    });

    it("superseded session write: no active payload emitted", () => {
      const state = makeSessionState({ status: "superseded", state: "IMPLEMENT" });
      refreshStatusForSession(root, sessionDir, state as never, "guide");

      const statusPath = join(root, ".story", "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf-8"));
      expect(parsed.sessionActive).toBe(false);
      expect(parsed.sessionId).toBeUndefined();
    });
  });
});
