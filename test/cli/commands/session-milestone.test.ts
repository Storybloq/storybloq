import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MilestoneWriteSchema,
  handleSessionMilestone,
} from "../../../src/cli/commands/session-milestone.js";
import { acquireLock, ensurePresenceDir, releaseLock, readBoundedNoFollow } from "../../../src/presence/io.js";
import { presenceFileBase, MAX_RECORD_BYTES } from "../../../src/presence/types.js";
import { parsePresenceRecord } from "../../../src/presence/record.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-milestone-test-"));
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), "{}");
  return root;
}

function readPresence(root: string, sessionId: string) {
  const dir = ensurePresenceDir(root)!;
  const text = readBoundedNoFollow(join(dir, `${presenceFileBase(sessionId)}.json`), MAX_RECORD_BYTES);
  return text === null ? null : parsePresenceRecord(text, sessionId);
}

describe("MilestoneWriteSchema", () => {
  it("accepts each of the four known kinds with only an optional note", () => {
    for (const kind of ["implementing", "blocked-external", "reviewing"] as const) {
      expect(MilestoneWriteSchema.safeParse({ kind }).success).toBe(true);
      expect(MilestoneWriteSchema.safeParse({ kind, note: "on it" }).success).toBe(true);
    }
  });

  it("requires gateName for kind=gate-hold, and rejects it missing", () => {
    expect(MilestoneWriteSchema.safeParse({ kind: "gate-hold" }).success).toBe(false);
    expect(MilestoneWriteSchema.safeParse({ kind: "gate-hold", gateName: "PLAN_REVIEW" }).success).toBe(true);
  });

  it("rejects a blank or whitespace-only gateName -- gate-hold exists to name a specific gate", () => {
    expect(MilestoneWriteSchema.safeParse({ kind: "gate-hold", gateName: "" }).success).toBe(false);
    expect(MilestoneWriteSchema.safeParse({ kind: "gate-hold", gateName: "   " }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(MilestoneWriteSchema.safeParse({ kind: "sleeping" }).success).toBe(false);
  });

  it("enforces the note/gateName limits in UTF-8 BYTES, not JS string length -- a multi-byte string can be under the code-unit count but over the byte ceiling", () => {
    // 500 CJK characters: length 500 (under any code-unit-based check of 500),
    // but 1500 UTF-8 bytes (over MAX_MILESTONE_NOTE_BYTES=500).
    const multiByteNote = "中".repeat(500);
    expect(multiByteNote.length).toBe(500);
    expect(Buffer.byteLength(multiByteNote, "utf8")).toBe(1500);
    expect(MilestoneWriteSchema.safeParse({ kind: "implementing", note: multiByteNote }).success).toBe(false);

    // The same character count, comfortably within the byte budget, is accepted.
    const shortMultiByteNote = "中".repeat(100);
    expect(MilestoneWriteSchema.safeParse({ kind: "implementing", note: shortMultiByteNote }).success).toBe(true);
  });
});

describe("handleSessionMilestone", () => {
  it("returns identity-unresolved with no explicit clientTaskId and no environment identity", () => {
    const root = makeRoot();
    try {
      const result = handleSessionMilestone(root, { kind: "implementing" }, undefined);
      expect(result).toEqual({
        ok: false,
        errorCode: "identity-unresolved",
        message: expect.stringContaining("clientTaskId"),
        retryable: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a milestone onto a fresh record, sourced distinctly from a hook-created one", () => {
    const root = makeRoot();
    try {
      const result = handleSessionMilestone(root, { kind: "reviewing", note: "checking the diff" }, "sess-fresh");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.kind).toBe("reviewing");

      const record = readPresence(root, "sess-fresh")!;
      expect(record).not.toBeNull();
      expect(record.source).toBe("milestone-command");
      expect(record.milestone).toEqual({ kind: "reviewing", at: result.at, note: "checking the diff" });
      expect(record.lastEventAt).toBe(result.at);
      expect(record.endedAt).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries gateName through for kind=gate-hold", () => {
    const root = makeRoot();
    try {
      const result = handleSessionMilestone(root, { kind: "gate-hold", gateName: "PLAN_REVIEW" }, "sess-gate");
      expect(result.ok).toBe(true);
      const record = readPresence(root, "sess-gate")!;
      expect(record.milestone).toEqual({ kind: "gate-hold", at: (result as { at: string }).at, gateName: "PLAN_REVIEW" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a milestone write clears endedAt and refreshes lastEventAt even over a tombstoned prior record (proof-of-life semantics)", () => {
    const root = makeRoot();
    try {
      const dir = ensurePresenceDir(root)!;
      const path = join(dir, `${presenceFileBase("sess-tombstoned")}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          sessionId: "sess-tombstoned",
          generation: 3,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastEventAt: "2026-01-01T00:00:00.000Z",
          source: "SessionEnd",
          openTools: [],
          closedToolIds: [],
          agentIds: [],
          suppressed: false,
          endedAt: "2026-01-01T00:00:00.000Z",
          arrangementPresence: [],
          arrangementPresenceTruncated: false,
          milestone: null,
          ownerIdentity: null,
        }) + "\n",
      );

      const result = handleSessionMilestone(root, { kind: "implementing" }, "sess-tombstoned");
      expect(result.ok).toBe(true);
      const record = readPresence(root, "sess-tombstoned")!;
      expect(record.endedAt).toBeNull();
      expect(record.lastEventAt).not.toBe("2026-01-01T00:00:00.000Z");
      // Fields unrelated to the milestone write are preserved, not reset.
      expect(record.generation).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports write-failed (skipped-no-directory), non-retryable, when the presence directory cannot be created", () => {
    const root = makeRoot();
    try {
      // Occupy the presence path with a FILE so ensurePresenceDir's mkdir fails.
      mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
      writeFileSync(join(root, ".story", "telemetry", "presence"), "not a directory");
      const result = handleSessionMilestone(root, { kind: "implementing" }, "sess-no-dir");
      expect(result).toEqual({
        ok: false,
        errorCode: "write-failed",
        message: expect.any(String),
        retryable: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports write-failed (skipped-too-large), non-retryable, when the mutated record exceeds MAX_RECORD_BYTES -- defense in depth beneath the schema's own byte limit", () => {
    const root = makeRoot();
    try {
      // The write-time schema already rejects an oversized note (see
      // MilestoneWriteSchema's tests); this proves applyPresenceEnrichment's
      // OWN size ceiling independently catches an oversized value that
      // somehow reached it anyway, rather than writing a truncated or
      // corrupt record.
      const oversizedNote = "x".repeat(MAX_RECORD_BYTES);
      const result = handleSessionMilestone(
        root,
        { kind: "implementing", note: oversizedNote } as unknown as Parameters<typeof handleSessionMilestone>[1],
        "sess-oversized",
      );
      expect(result).toEqual({
        ok: false,
        errorCode: "write-failed",
        message: expect.any(String),
        retryable: false,
      });
      expect(readPresence(root, "sess-oversized")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports lock-busy explicitly, and writes nothing, when another process holds the presence lock for the whole budget", () => {
    const root = makeRoot();
    const dir = ensurePresenceDir(root)!;
    const lockPath = join(dir, `${presenceFileBase("sess-contended")}.lock`);
    expect(acquireLock(lockPath)).toBe(true); // simulates a concurrent heavy-path writer
    try {
      const result = handleSessionMilestone(root, { kind: "implementing" }, "sess-contended");
      expect(result).toEqual({
        ok: false,
        errorCode: "lock-busy",
        message: expect.any(String),
        retryable: true,
      });
      // Never a false "written": no record exists at all for this session.
      expect(readPresence(root, "sess-contended")).toBeNull();
    } finally {
      releaseLock(lockPath);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
