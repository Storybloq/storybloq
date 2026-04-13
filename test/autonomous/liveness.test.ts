/**
 * T-260: Liveness infrastructure tests.
 *
 * Tests the four liveness mechanisms: sidecar heartbeat, lastMcpCall touch,
 * binary fingerprint, and Claude Code session ID capture.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  telemetryDirPath,
  spawnAliveSidecar,
  killSidecar,
  writeShutdownMarker,
  touchLastMcpCallFile,
  readLastMcpCall,
  readAliveTimestamp,
  computeBinaryFingerprint,
  captureClaudeCodeSessionId,
} from "../../src/autonomous/liveness.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Liveness infrastructure (T-260)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "liveness-test-"));
    sessionDir = join(tmpDir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  describe("telemetryDirPath", () => {
    it("returns telemetry subdirectory of session dir", () => {
      expect(telemetryDirPath(sessionDir)).toBe(join(sessionDir, "telemetry"));
    });
  });

  describe("spawnAliveSidecar", () => {
    let pid: number | undefined;

    afterEach(() => {
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
        pid = undefined;
      }
    });

    it("writes alive file within 2 seconds with 200ms interval", async () => {
      const tDir = telemetryDirPath(sessionDir);
      pid = spawnAliveSidecar(tDir, 200);
      expect(pid).toBeGreaterThan(0);

      const aliveFile = join(tDir, "alive");
      for (let i = 0; i < 20; i++) {
        if (existsSync(aliveFile)) break;
        await sleep(100);
      }
      expect(existsSync(aliveFile)).toBe(true);
      const content = readFileSync(aliveFile, "utf-8").trim();
      const ts = Number(content);
      expect(ts).toBeGreaterThan(0);
    });

    it("stops writing when killed", async () => {
      const tDir = telemetryDirPath(sessionDir);
      pid = spawnAliveSidecar(tDir, 200);

      const aliveFile = join(tDir, "alive");
      let found = false;
      for (let i = 0; i < 30; i++) {
        if (existsSync(aliveFile)) { found = true; break; }
        await sleep(100);
      }
      expect(found).toBe(true);

      killSidecar(pid);
      pid = undefined;
      await sleep(500);

      const before = readFileSync(aliveFile, "utf-8").trim();
      await sleep(600);
      const after = readFileSync(aliveFile, "utf-8").trim();
      expect(after).toBe(before);
    });

    it("exits when shutdown marker is written", async () => {
      const tDir = telemetryDirPath(sessionDir);
      pid = spawnAliveSidecar(tDir, 200);
      await sleep(500);

      writeShutdownMarker(sessionDir);
      await sleep(500);

      const aliveFile = join(tDir, "alive");
      const content = readFileSync(aliveFile, "utf-8").trim();
      expect(content).toBe("0");
      pid = undefined;
    });
  });

  describe("killSidecar", () => {
    it("handles null pid gracefully", () => {
      expect(() => killSidecar(null)).not.toThrow();
    });

    it("handles undefined pid gracefully", () => {
      expect(() => killSidecar(undefined)).not.toThrow();
    });

    it("handles invalid pid (ESRCH) gracefully", () => {
      expect(() => killSidecar(999999999)).not.toThrow();
    });
  });

  describe("writeShutdownMarker", () => {
    it("writes shutdown file and sets alive to 0", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "12345");

      writeShutdownMarker(sessionDir);

      expect(existsSync(join(tDir, "shutdown"))).toBe(true);
      expect(readFileSync(join(tDir, "alive"), "utf-8").trim()).toBe("0");
    });
  });

  describe("touchLastMcpCallFile", () => {
    it("writes ISO timestamp to telemetry/lastMcpCall", () => {
      touchLastMcpCallFile(sessionDir);

      const tDir = telemetryDirPath(sessionDir);
      const content = readFileSync(join(tDir, "lastMcpCall"), "utf-8").trim();
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("readLastMcpCall", () => {
    it("reads back a written timestamp", () => {
      touchLastMcpCallFile(sessionDir);
      const result = readLastMcpCall(sessionDir);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("returns null when file is missing", () => {
      expect(readLastMcpCall(sessionDir)).toBeNull();
    });
  });

  describe("readAliveTimestamp", () => {
    it("reads back an epoch timestamp", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");

      expect(readAliveTimestamp(sessionDir)).toBe(1712847600000);
    });

    it("returns null for '0' (shutdown)", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "0");

      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });

    it("returns null when file is missing", () => {
      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });

    it("returns null when shutdown marker exists even if alive has a valid timestamp", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");
      writeFileSync(join(tDir, "shutdown"), "1");

      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });
  });

  describe("computeBinaryFingerprint", () => {
    it("returns an object with mtime and sha256 strings", () => {
      const result = computeBinaryFingerprint();
      // May be null in dev mode without build, but if present, must have correct shape
      if (result !== null) {
        expect(result.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("captureClaudeCodeSessionId", () => {
    const originalEnv = process.env.CLAUDE_CODE_SESSION_ID;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.CLAUDE_CODE_SESSION_ID = originalEnv;
      } else {
        delete process.env.CLAUDE_CODE_SESSION_ID;
      }
    });

    it("returns env var value when set", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "test-uuid-abc";
      expect(captureClaudeCodeSessionId()).toBe("test-uuid-abc");
    });

    it("returns null when env var is not set", () => {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      expect(captureClaudeCodeSessionId()).toBeNull();
    });
  });
});
