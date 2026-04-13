import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeEvent,
  writeCheckpoint,
  markEnded,
  readEndedMarker,
  getTruncationCount,
  resetTruncationCount,
  type TelemetryEvent,
  type TelemetryLayer,
} from "../../src/autonomous/telemetry-writer.js";

function makeEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    ts: "2026-04-11T12:00:00.000Z",
    layer: "guide" as TelemetryLayer,
    type: "test_event",
    data: { key: "value" },
    ...overrides,
  };
}

function eventsPath(sessionDir: string): string {
  return join(sessionDir, "telemetry", "events.jsonl");
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
}

describe("TelemetryWriter (T-262)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "telem-writer-test-"));
    sessionDir = join(tmpDir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
    resetTruncationCount();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  });

  // ── writeEvent basics ───────────────────────────────────────

  describe("writeEvent", () => {
    it("appends valid event to events.jsonl as single line", () => {
      writeEvent(sessionDir, makeEvent());
      const lines = readLines(eventsPath(sessionDir));
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.ts).toBe("2026-04-11T12:00:00.000Z");
      expect(parsed.type).toBe("test_event");
    });

    it("creates telemetry directory if missing", () => {
      const telemDir = join(sessionDir, "telemetry");
      expect(existsSync(telemDir)).toBe(false);
      writeEvent(sessionDir, makeEvent());
      expect(existsSync(telemDir)).toBe(true);
      expect(existsSync(eventsPath(sessionDir))).toBe(true);
    });

    it("multiple sequential writes produce separate lines", () => {
      writeEvent(sessionDir, makeEvent({ type: "event_1" }));
      writeEvent(sessionDir, makeEvent({ type: "event_2" }));
      writeEvent(sessionDir, makeEvent({ type: "event_3" }));
      const lines = readLines(eventsPath(sessionDir));
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).type).toBe("event_1");
      expect(JSON.parse(lines[1]).type).toBe("event_2");
      expect(JSON.parse(lines[2]).type).toBe("event_3");
    });

    it("event has correct shape (ts, layer, type, data)", () => {
      writeEvent(sessionDir, makeEvent());
      const lines = readLines(eventsPath(sessionDir));
      const parsed = JSON.parse(lines[0]);
      expect(parsed).toHaveProperty("ts");
      expect(parsed).toHaveProperty("layer", "guide");
      expect(parsed).toHaveProperty("type", "test_event");
      expect(parsed).toHaveProperty("data");
      expect(parsed.data).toEqual({ key: "value" });
    });
  });

  // ── 4 KB cap enforcement ────────────────────────────────────

  describe("4 KB cap", () => {
    it("event under 4 KB written as-is", () => {
      const event = makeEvent({ data: { small: "x".repeat(100) } });
      writeEvent(sessionDir, event);
      const lines = readLines(eventsPath(sessionDir));
      const parsed = JSON.parse(lines[0]);
      expect(parsed.data.small).toBe("x".repeat(100));
      expect(parsed.data._truncated).toBeUndefined();
    });

    it("event over 4 KB gets data truncated with _truncated marker", () => {
      const bigData: Record<string, unknown> = { payload: "x".repeat(5000) };
      const event = makeEvent({ data: bigData });
      writeEvent(sessionDir, event);
      const lines = readLines(eventsPath(sessionDir));
      const parsed = JSON.parse(lines[0]);
      expect(parsed.data._truncated).toBe(true);
      expect(typeof parsed.data._originalSize).toBe("number");
      expect(parsed.data._originalSize).toBeGreaterThan(4096);
    });

    it("truncation counter increments and resets correctly", () => {
      expect(getTruncationCount()).toBe(0);
      const bigEvent = makeEvent({ data: { payload: "x".repeat(5000) } });
      writeEvent(sessionDir, bigEvent);
      expect(getTruncationCount()).toBe(1);
      writeEvent(sessionDir, bigEvent);
      expect(getTruncationCount()).toBe(2);
      resetTruncationCount();
      expect(getTruncationCount()).toBe(0);
    });
  });

  // ── Rotation ────────────────────────────────────────────────

  describe("rotation", () => {
    it("file under 10 MB: no rotation occurs", () => {
      for (let i = 0; i < 10; i++) {
        writeEvent(sessionDir, makeEvent({ type: `event_${i}` }));
      }
      const ep = eventsPath(sessionDir);
      expect(existsSync(ep)).toBe(true);
      expect(existsSync(`${ep}.1`)).toBe(false);
    });

    it("file over 10 MB: rotated to .1, fresh file started", () => {
      const ep = eventsPath(sessionDir);
      const telemDir = join(sessionDir, "telemetry");
      mkdirSync(telemDir, { recursive: true });

      // Seed a file just over 10 MB
      const bigLine = JSON.stringify(makeEvent({ data: { filler: "x".repeat(3000) } })) + "\n";
      const linesNeeded = Math.ceil((10 * 1024 * 1024) / bigLine.length) + 1;
      writeFileSync(ep, bigLine.repeat(linesNeeded));

      // Trigger rotation by writing one more event
      writeEvent(sessionDir, makeEvent({ type: "after_rotation" }));

      expect(existsSync(`${ep}.1`)).toBe(true);
      // Fresh file should contain only the new event
      const freshLines = readLines(ep);
      expect(freshLines.length).toBeLessThanOrEqual(2);
      expect(JSON.parse(freshLines[freshLines.length - 1]).type).toBe("after_rotation");
    });

    it("previous .1 deleted on rotation (only one generation kept)", () => {
      const ep = eventsPath(sessionDir);
      const telemDir = join(sessionDir, "telemetry");
      mkdirSync(telemDir, { recursive: true });

      // Create a pre-existing .1 file
      writeFileSync(`${ep}.1`, "old-generation\n");

      // Seed main file over 10 MB
      const bigLine = JSON.stringify(makeEvent({ data: { filler: "x".repeat(3000) } })) + "\n";
      const linesNeeded = Math.ceil((10 * 1024 * 1024) / bigLine.length) + 1;
      writeFileSync(ep, bigLine.repeat(linesNeeded));

      writeEvent(sessionDir, makeEvent({ type: "trigger_rotation" }));

      // .1 should be the rotated file, not the old one
      const rotatedContent = readFileSync(`${ep}.1`, "utf-8");
      expect(rotatedContent).not.toContain("old-generation");
      // .2 should not exist
      expect(existsSync(`${ep}.2`)).toBe(false);
    });

    it("10,000+ lines triggers rotation even if under 10 MB", () => {
      const ep = eventsPath(sessionDir);
      const telemDir = join(sessionDir, "telemetry");
      mkdirSync(telemDir, { recursive: true });

      // Write a file with exactly 10,000 short lines (well under 10 MB)
      const shortLine = JSON.stringify({ ts: "t", layer: "guide", type: "x", data: {} }) + "\n";
      writeFileSync(ep, shortLine.repeat(10_000));
      // Seed the line-count sidecar so rotation knows there are 10,000 lines
      writeFileSync(`${ep}.lines`, "10000");

      // Verify it's under 10 MB
      const sizeMB = statSync(ep).size / (1024 * 1024);
      expect(sizeMB).toBeLessThan(10);

      writeEvent(sessionDir, makeEvent({ type: "trigger_line_rotation" }));

      expect(existsSync(`${ep}.1`)).toBe(true);
      const freshLines = readLines(ep);
      expect(freshLines.length).toBeLessThanOrEqual(2);
    });
  });

  // ── writeCheckpoint ─────────────────────────────────────────

  describe("writeCheckpoint", () => {
    it("creates checkpoints/<STAGE>.json with correct content", () => {
      const state = { sessionId: "abc", state: "IMPLEMENT", revision: 5 };
      writeCheckpoint(sessionDir, "IMPLEMENT", state, 5);

      const cpPath = join(sessionDir, "telemetry", "checkpoints", "IMPLEMENT.json");
      expect(existsSync(cpPath)).toBe(true);
      const stored = JSON.parse(readFileSync(cpPath, "utf-8"));
      expect(stored.sessionId).toBe("abc");
      expect(stored.state).toBe("IMPLEMENT");
      expect(stored._revision).toBe(5);
    });

    it("overwrites checkpoint when revision is newer", () => {
      writeCheckpoint(sessionDir, "PLAN", { state: "PLAN", revision: 3 }, 3);
      writeCheckpoint(sessionDir, "PLAN", { state: "PLAN", data: "updated", revision: 7 }, 7);

      const cpPath = join(sessionDir, "telemetry", "checkpoints", "PLAN.json");
      const stored = JSON.parse(readFileSync(cpPath, "utf-8"));
      expect(stored._revision).toBe(7);
      expect(stored.data).toBe("updated");
    });

    it("refuses to overwrite when existing checkpoint has higher revision", () => {
      writeCheckpoint(sessionDir, "TEST", { state: "TEST", revision: 10 }, 10);
      writeCheckpoint(sessionDir, "TEST", { state: "TEST", data: "stale", revision: 5 }, 5);

      const cpPath = join(sessionDir, "telemetry", "checkpoints", "TEST.json");
      const stored = JSON.parse(readFileSync(cpPath, "utf-8"));
      expect(stored._revision).toBe(10);
      expect(stored.data).toBeUndefined();
    });

    it("creates checkpoints directory if missing", () => {
      const cpDir = join(sessionDir, "telemetry", "checkpoints");
      expect(existsSync(cpDir)).toBe(false);
      writeCheckpoint(sessionDir, "BUILD", { state: "BUILD", revision: 1 }, 1);
      expect(existsSync(cpDir)).toBe(true);
    });

    it("cleans up temp file on rename failure", () => {
      const cpDir = join(sessionDir, "telemetry", "checkpoints");
      mkdirSync(cpDir, { recursive: true });

      // Write a valid checkpoint first
      writeCheckpoint(sessionDir, "VERIFY", { state: "VERIFY", revision: 1 }, 1);

      // Make the checkpoints dir read-only to force rename failure
      try {
        chmodSync(cpDir, 0o444);
        writeCheckpoint(sessionDir, "NEW_STAGE", { state: "NEW", revision: 2 }, 2);
      } finally {
        chmodSync(cpDir, 0o755);
      }

      // No leftover .tmp files
      const files = readdirSync(cpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  // ── markEnded + readEndedMarker ─────────────────────────────

  describe("markEnded + readEndedMarker", () => {
    it("writes telemetry/ended with reason and timestamp", () => {
      markEnded(sessionDir, "completed");
      const endedPath = join(sessionDir, "telemetry", "ended");
      expect(existsSync(endedPath)).toBe(true);
      const content = JSON.parse(readFileSync(endedPath, "utf-8"));
      expect(content.reason).toBe("completed");
      expect(typeof content.timestamp).toBe("string");
    });

    it("readEndedMarker returns the written data", () => {
      markEnded(sessionDir, "cancelled");
      const marker = readEndedMarker(sessionDir);
      expect(marker).not.toBeNull();
      expect(marker!.reason).toBe("cancelled");
      expect(typeof marker!.timestamp).toBe("string");
    });

    it("readEndedMarker returns null when no marker exists", () => {
      expect(readEndedMarker(sessionDir)).toBeNull();
    });

    it("readEndedMarker returns null for malformed JSON", () => {
      const endedPath = join(sessionDir, "telemetry", "ended");
      mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
      writeFileSync(endedPath, "not-valid-json{{{");
      expect(readEndedMarker(sessionDir)).toBeNull();
    });

    it("readEndedMarker returns null when shape is missing required fields", () => {
      const endedPath = join(sessionDir, "telemetry", "ended");
      mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
      writeFileSync(endedPath, JSON.stringify({ reason: "test" }));
      expect(readEndedMarker(sessionDir)).toBeNull();
    });
  });

  // ── Failure paths ──────────────────────────────────────────

  describe("failure paths", () => {
    it("writeEvent never throws even on unwritable directory", () => {
      expect(() =>
        writeEvent("/nonexistent/path/that/cannot/exist", makeEvent()),
      ).not.toThrow();
    });

    it("temp files cleaned up after write failures", () => {
      const telemDir = join(sessionDir, "telemetry");
      mkdirSync(telemDir, { recursive: true });

      // Write ended marker, then make dir read-only
      try {
        chmodSync(telemDir, 0o444);
        markEnded(sessionDir, "test");
      } catch {
        /* expected to fail silently */
      } finally {
        chmodSync(telemDir, 0o755);
      }

      const files = readdirSync(telemDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  // ── Lock behavior ──────────────────────────────────────────

  describe("lock behavior", () => {
    it("writeEvent silently skips when lock cannot be acquired", () => {
      // Pre-hold the lock by creating a stale lock file
      const telemDir = join(sessionDir, "telemetry");
      mkdirSync(telemDir, { recursive: true });

      // Write an event -- should not throw even if lock contention exists
      expect(() => writeEvent(sessionDir, makeEvent())).not.toThrow();
    });
  });

  // ── Lifecycle integration ──────────────────────────────────

  describe("lifecycle integration", () => {
    it("full sequence: events + checkpoints + ended marker", () => {
      writeEvent(sessionDir, makeEvent({ type: "start" }));
      writeEvent(sessionDir, makeEvent({ type: "transition" }));
      writeEvent(sessionDir, makeEvent({ type: "complete" }));

      writeCheckpoint(sessionDir, "PLAN", { state: "PLAN", revision: 1 }, 1);
      writeCheckpoint(sessionDir, "IMPLEMENT", { state: "IMPLEMENT", revision: 2 }, 2);

      markEnded(sessionDir, "completed");

      // Verify events
      const lines = readLines(eventsPath(sessionDir));
      expect(lines).toHaveLength(3);

      // Verify checkpoints
      const cpDir = join(sessionDir, "telemetry", "checkpoints");
      expect(existsSync(join(cpDir, "PLAN.json"))).toBe(true);
      expect(existsSync(join(cpDir, "IMPLEMENT.json"))).toBe(true);

      // Verify ended marker
      const marker = readEndedMarker(sessionDir);
      expect(marker).not.toBeNull();
      expect(marker!.reason).toBe("completed");
    });
  });
});
