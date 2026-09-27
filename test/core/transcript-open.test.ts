import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, closeSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTranscriptReadOnly } from "../../src/core/transcript-open.js";

// T-534: the shared open prelude moved out of limit-transcript unchanged. It
// opens and classifies only; the read cap belongs to its callers (transcript-scan).
describe("openTranscriptReadOnly", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-transcript-open-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a regular file with its size and dev:ino incarnation", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "abc\n");
    const o = openTranscriptReadOnly(path)!;
    try {
      const st = statSync(path);
      expect(o.size).toBe(4);
      expect(o.incarnation).toBe(`${st.dev}:${st.ino}`);
    } finally {
      closeSync(o.fd);
    }
  });

  it("refuses an absent path, a symlink at the final component and a FIFO", () => {
    expect(openTranscriptReadOnly(join(dir, "absent.jsonl"))).toBeNull();
    const target = join(dir, "real.jsonl");
    writeFileSync(target, "x\n");
    symlinkSync(target, join(dir, "link.jsonl"));
    expect(openTranscriptReadOnly(join(dir, "link.jsonl"))).toBeNull();
    const fifo = join(dir, "pipe.jsonl");
    if (spawnSync("mkfifo", [fifo]).status === 0) expect(openTranscriptReadOnly(fifo)).toBeNull();
  });
});
