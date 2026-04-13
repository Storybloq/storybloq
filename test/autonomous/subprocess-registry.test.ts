import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  sanitizeCmd,
  registerSubprocess,
  unregisterSubprocess,
  readSubprocessSummaries,
  subprocessesDir,
  SUBPROCESS_CATEGORIES,
  type SubprocessEntry,
  type SubprocessSummary,
} from "../../src/autonomous/subprocess-registry.js";

describe("Subprocess registry (T-261)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "subprocess-reg-test-"));
    sessionDir = join(tmpDir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  });

  // ── sanitizeCmd ──────────────────────────────────────────────

  describe("sanitizeCmd", () => {
    it("strips path and arguments, returns basename", () => {
      expect(sanitizeCmd("/usr/bin/xcodebuild -project Foo.xcodeproj -scheme Release")).toBe(
        "xcodebuild",
      );
    });

    it("handles bare executable name", () => {
      expect(sanitizeCmd("npm")).toBe("npm");
    });

    it("returns 'unknown' for empty string", () => {
      expect(sanitizeCmd("")).toBe("unknown");
    });

    it("handles path without arguments", () => {
      expect(sanitizeCmd("/usr/local/bin/node")).toBe("node");
    });

    it("handles whitespace-only input", () => {
      expect(sanitizeCmd("   ")).toBe("unknown");
    });

    it("strips double quotes from executable", () => {
      expect(sanitizeCmd('"/usr/bin/xcodebuild" -project Foo')).toBe("xcodebuild");
    });

    it("strips single quotes from executable", () => {
      expect(sanitizeCmd("'/usr/bin/node' --version")).toBe("node");
    });
  });

  // ── registerSubprocess ───────────────────────────────────────

  describe("registerSubprocess", () => {
    it("creates per-PID JSON file with correct content", () => {
      const entry: SubprocessEntry = {
        pid: 12345,
        cmd: "xcodebuild",
        category: "xcodebuild",
        startedAt: "2026-04-11T10:00:00.000Z",
        stage: "IMPLEMENT",
      };
      registerSubprocess(sessionDir, entry);

      const filePath = join(subprocessesDir(sessionDir), "12345.json");
      expect(existsSync(filePath)).toBe(true);

      const stored = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(stored.pid).toBe(12345);
      expect(stored.cmd).toBe("xcodebuild");
      expect(stored.category).toBe("xcodebuild");
      expect(stored.startedAt).toBe("2026-04-11T10:00:00.000Z");
      expect(stored.stage).toBe("IMPLEMENT");
    });

    it("creates subprocesses directory if it does not exist", () => {
      const entry: SubprocessEntry = {
        pid: 99999,
        cmd: "npm",
        category: "npm-test",
        startedAt: new Date().toISOString(),
        stage: "TEST",
      };
      registerSubprocess(sessionDir, entry);
      expect(existsSync(subprocessesDir(sessionDir))).toBe(true);
    });

    it("uses compact JSON (no pretty-print)", () => {
      const entry: SubprocessEntry = {
        pid: 77777,
        cmd: "node",
        category: "other",
        startedAt: "2026-04-11T10:00:00.000Z",
        stage: "TEST",
      };
      registerSubprocess(sessionDir, entry);
      const raw = readFileSync(join(subprocessesDir(sessionDir), "77777.json"), "utf-8");
      // Compact JSON: single line with trailing newline, no indentation
      expect(raw).not.toContain("\n  ");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual(entry);
    });

    it("overwrites existing file for same PID (re-register)", () => {
      const entry1: SubprocessEntry = {
        pid: 5555,
        cmd: "npm",
        category: "npm-test",
        startedAt: "2026-04-11T10:00:00.000Z",
        stage: "TEST",
      };
      const entry2: SubprocessEntry = {
        ...entry1,
        stage: "BUILD",
        startedAt: "2026-04-11T11:00:00.000Z",
      };
      registerSubprocess(sessionDir, entry1);
      registerSubprocess(sessionDir, entry2);

      const stored = JSON.parse(
        readFileSync(join(subprocessesDir(sessionDir), "5555.json"), "utf-8"),
      );
      expect(stored.stage).toBe("BUILD");
    });
  });

  // ── unregisterSubprocess ─────────────────────────────────────

  describe("unregisterSubprocess", () => {
    it("deletes the per-PID file", () => {
      const entry: SubprocessEntry = {
        pid: 12345,
        cmd: "xcodebuild",
        category: "xcodebuild",
        startedAt: new Date().toISOString(),
        stage: "IMPLEMENT",
      };
      registerSubprocess(sessionDir, entry);
      const filePath = join(subprocessesDir(sessionDir), "12345.json");
      expect(existsSync(filePath)).toBe(true);

      unregisterSubprocess(sessionDir, 12345);
      expect(existsSync(filePath)).toBe(false);
    });

    it("is idempotent -- no error on missing PID", () => {
      expect(() => unregisterSubprocess(sessionDir, 99999)).not.toThrow();
    });

    it("is idempotent -- no error when directory does not exist", () => {
      expect(() => unregisterSubprocess(join(tmpDir, "nonexistent"), 12345)).not.toThrow();
    });
  });

  // ── readSubprocessSummaries ──────────────────────────────────

  describe("readSubprocessSummaries", () => {
    it("returns Tier 1 summaries (no cmd field)", () => {
      const entry: SubprocessEntry = {
        pid: process.pid,
        cmd: "node",
        category: "other",
        startedAt: new Date().toISOString(),
        stage: "IMPLEMENT",
      };
      registerSubprocess(sessionDir, entry);

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].pid).toBe(process.pid);
      expect(summaries[0].category).toBe("other");
      expect(summaries[0].stage).toBe("IMPLEMENT");
      expect((summaries[0] as Record<string, unknown>).cmd).toBeUndefined();
    });

    it("returns empty array for empty directory", () => {
      mkdirSync(subprocessesDir(sessionDir), { recursive: true });
      expect(readSubprocessSummaries(sessionDir)).toEqual([]);
    });

    it("returns empty array when directory does not exist", () => {
      expect(readSubprocessSummaries(join(tmpDir, "nonexistent"))).toEqual([]);
    });

    it("skips malformed JSON files", () => {
      const dir = subprocessesDir(sessionDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bad.json"), "not valid json{{{");

      const validEntry: SubprocessEntry = {
        pid: process.pid,
        cmd: "node",
        category: "other",
        startedAt: new Date().toISOString(),
        stage: "TEST",
      };
      registerSubprocess(sessionDir, validEntry);

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].pid).toBe(process.pid);
    });

    it("prunes dead PIDs and deletes their files", () => {
      // ISS-437: Use PID_MAX (kernel-enforced max on Linux/macOS) minus 1.
      // No real process will hold this PID during a test run.
      const deadPid = 4194303;
      const entry: SubprocessEntry = {
        pid: deadPid,
        cmd: "ghost",
        category: "other",
        startedAt: new Date().toISOString(),
        stage: "IMPLEMENT",
      };
      registerSubprocess(sessionDir, entry);
      const filePath = join(subprocessesDir(sessionDir), `${deadPid}.json`);
      expect(existsSync(filePath)).toBe(true);

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(0);
      expect(existsSync(filePath)).toBe(false);
    });

    // ISS-440: Edge cases for invalid PIDs in JSON files
    it("prunes pid:0 entries (isPidAlive rejects non-positive)", () => {
      const dir = subprocessesDir(sessionDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "0.json"),
        JSON.stringify({ pid: 0, cmd: "z", category: "other", startedAt: "2026-01-01T00:00:00Z", stage: "TEST" }) + "\n",
      );

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(0);
      expect(existsSync(join(dir, "0.json"))).toBe(false);
    });

    it("prunes pid:-1 entries (isPidAlive rejects negative)", () => {
      const dir = subprocessesDir(sessionDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "-1.json"),
        JSON.stringify({ pid: -1, cmd: "z", category: "other", startedAt: "2026-01-01T00:00:00Z", stage: "TEST" }) + "\n",
      );

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(0);
      expect(existsSync(join(dir, "-1.json"))).toBe(false);
    });

    it("skips entries with missing pid field", () => {
      const dir = subprocessesDir(sessionDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "nopid.json"), JSON.stringify({ category: "other" }) + "\n");

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(0);
    });

    it("keeps alive PIDs (current process)", () => {
      const entry: SubprocessEntry = {
        pid: process.pid,
        cmd: "node",
        category: "other",
        startedAt: "2020-01-01T00:00:00.000Z",
        stage: "IMPLEMENT",
      };
      registerSubprocess(sessionDir, entry);

      const summaries = readSubprocessSummaries(sessionDir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].pid).toBe(process.pid);
    });
  });

  // ── per-PID file isolation ───────────────────────────────────
  // ISS-441: Renamed from "concurrent registrations" -- the for-loop is sequential.
  // The test verifies file-per-PID isolation, not true concurrency.

  describe("per-PID file isolation", () => {
    it("each PID gets its own file (no lost updates)", () => {
      const pids = [1001, 1002, 1003];
      for (const pid of pids) {
        registerSubprocess(sessionDir, {
          pid,
          cmd: "test",
          category: "other",
          startedAt: new Date().toISOString(),
          stage: "TEST",
        });
      }

      const dir = subprocessesDir(sessionDir);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(3);
      expect(files.sort()).toEqual(["1001.json", "1002.json", "1003.json"]);
    });
  });

  // ── Tier 1 privacy ──────────────────────────────────────────

  describe("Tier 1 privacy contract", () => {
    it("cmd never appears in SubprocessSummary output", () => {
      registerSubprocess(sessionDir, {
        pid: process.pid,
        cmd: "secret-binary",
        category: "other",
        startedAt: new Date().toISOString(),
        stage: "IMPLEMENT",
      });

      const summaries = readSubprocessSummaries(sessionDir);
      for (const s of summaries) {
        const keys = Object.keys(s);
        expect(keys).not.toContain("cmd");
        expect(JSON.stringify(s)).not.toContain("secret-binary");
      }
    });
  });

  // ── category enum ───────────────────────────────────────────

  describe("category enum", () => {
    it("exports all 6 valid categories", () => {
      expect(SUBPROCESS_CATEGORIES).toEqual([
        "xcodebuild",
        "codex",
        "swift-test",
        "lens-review",
        "npm-test",
        "other",
      ]);
    });
  });

  // ── subprocessesDir ─────────────────────────────────────────

  describe("subprocessesDir", () => {
    it("returns telemetry/subprocesses path under session dir", () => {
      const result = subprocessesDir("/fake/session");
      expect(result).toBe("/fake/session/telemetry/subprocesses");
    });
  });
});
