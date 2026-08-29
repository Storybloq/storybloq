import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanSnapshot, readPlanSnapshot, type PlanSnapshotRef } from "../../src/core/plan-snapshot.js";
import { sha256Bytes } from "../../src/core/pin-utils.js";

describe("[ISS-1050] plan-snapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-snapshot-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a content-addressed snapshot and reads it back", async () => {
    const bytes = Buffer.from("# Plan\n\nDo the thing.", "utf-8");
    const write = await writePlanSnapshot(dir, bytes);
    expect(write.status).toBe("ok");
    if (write.status !== "ok") return;
    expect(write.ref.filename).toBe(`plan-approved-${sha256Bytes(bytes)}.md`);
    expect(write.ref.sha256).toBe(sha256Bytes(bytes));

    const read = readPlanSnapshot(dir, write.ref);
    expect(read).toEqual({ status: "ok", text: bytes.toString("utf-8") });
  });

  it("is idempotent: writing identical content twice succeeds both times", async () => {
    const bytes = Buffer.from("same content", "utf-8");
    const first = await writePlanSnapshot(dir, bytes);
    const second = await writePlanSnapshot(dir, bytes);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(second.ref).toEqual(first.ref);
    }
  });

  it("[R2-FIX 4] refuses to write invalid UTF-8 rather than silently corrupting the snapshot", async () => {
    // A lone continuation byte -- not valid UTF-8 on its own.
    const invalid = Buffer.from([0xff, 0xfe, 0x80]);
    const write = await writePlanSnapshot(dir, invalid);
    expect(write.status).toBe("unreadable");
  });

  it("readPlanSnapshot detects content that no longer matches its recorded hash (hand-edited file)", async () => {
    const bytes = Buffer.from("original", "utf-8");
    const write = await writePlanSnapshot(dir, bytes);
    if (write.status !== "ok") throw new Error("setup failed");
    writeFileSync(join(dir, write.ref.filename), "tampered", "utf-8");
    const read = readPlanSnapshot(dir, write.ref);
    expect(read.status).toBe("unreadable");
  });

  it("readPlanSnapshot returns unreadable when the file does not exist", () => {
    const ref: PlanSnapshotRef = { filename: `plan-approved-${"a".repeat(64)}.md`, sha256: "a".repeat(64) };
    const read = readPlanSnapshot(dir, ref);
    expect(read.status).toBe("unreadable");
  });

  it("[R1-FIX 8] rejects a filename containing a path traversal sequence", () => {
    const ref: PlanSnapshotRef = { filename: `../../../etc/passwd`, sha256: "a".repeat(64) };
    const read = readPlanSnapshot(dir, ref);
    expect(read.status).toBe("unreadable");
  });

  it("[R1-FIX 8] rejects an absolute-path filename", () => {
    const ref: PlanSnapshotRef = { filename: `/etc/passwd`, sha256: "a".repeat(64) };
    const read = readPlanSnapshot(dir, ref);
    expect(read.status).toBe("unreadable");
  });

  it("[R1-FIX 8] rejects a filename not matching the content-address pattern", () => {
    const ref: PlanSnapshotRef = { filename: `not-a-snapshot.md`, sha256: "a".repeat(64) };
    const read = readPlanSnapshot(dir, ref);
    expect(read.status).toBe("unreadable");
  });

  it("[R1-FIX 8] rejects a filename/hash pair that don't match each other, even if a file happens to exist at that path", () => {
    const realHash = "b".repeat(64);
    const fakeHash = "c".repeat(64);
    const filename = `plan-approved-${realHash}.md`;
    writeFileSync(join(dir, filename), "content", "utf-8");
    // ref claims sha256 fakeHash, but the filename embeds realHash -- mismatch caught before any file read.
    const ref: PlanSnapshotRef = { filename, sha256: fakeHash };
    const read = readPlanSnapshot(dir, ref);
    expect(read.status).toBe("unreadable");
  });
});
