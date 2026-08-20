/**
 * ISS-1022: path safety for the presence writer.
 *
 * Stated honestly rather than optimistically: Node has no `openat`, so a
 * directory validated as a string can be swapped for a symlink before a later
 * child operation, and `src/bus/paths.ts` already documents that residual for
 * this codebase. What these tests pin is what IS enforced -- components
 * verified, symlinks and non-directories refused, reads bounded by type and
 * size, dev/ino revalidated around the rename, unlink restricted to regular
 * files inside a revalidated directory, and a failed post-check reported as a
 * FAILED write rather than as success.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  atomicWriteInDir,
  directoryIdentity,
  ensurePresenceDir,
  readBoundedNoFollow,
  removeRegularFile,
} from "../../src/presence/io.js";
import { runPresenceHook } from "../../src/presence/handler.js";
import { MAX_RECORD_BYTES } from "../../src/presence/types.js";

const SESSION = "sess-paths-1";
let root: string;
let presenceDir: string;

function hook(event: string, over: Record<string, unknown> = {}) {
  return runPresenceHook({ hook_event_name: event, session_id: SESSION, cwd: root, ...over });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "presence-paths-"));
  mkdirSync(join(root, ".story"));
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ version: 1 }));
  presenceDir = join(root, ".story", "telemetry", "presence");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("presence directory safety (ISS-1022)", () => {
  /**
   * `mkdirSync(..., { recursive: true })` accepts an existing symlink at any
   * level and would silently write THROUGH it, which is why every level is
   * created plainly and then validated with lstat.
   */
  it("refuses to write when the presence directory is a symlink", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "presence-elsewhere-"));
    try {
      mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
      symlinkSync(elsewhere, presenceDir, "dir");
      expect(hook("SessionStart", { source: "startup" })).toBe("skipped-no-directory");
      expect(existsSync(join(elsewhere, `${SESSION}.json`))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses when an ancestor of the presence directory is a symlink", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "presence-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(root, ".story", "telemetry"), "dir");
      expect(hook("SessionStart", { source: "startup" })).toBe("skipped-no-directory");
      expect(existsSync(join(elsewhere, "presence"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses when a regular file occupies the presence directory path", () => {
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
    writeFileSync(presenceDir, "not a directory");
    expect(hook("SessionStart", { source: "startup" })).toBe("skipped-no-directory");
  });

  it("creates the chain when it is absent, and is idempotent", () => {
    expect(ensurePresenceDir(root)).toBe(presenceDir);
    expect(ensurePresenceDir(root)).toBe(presenceDir);
    expect(directoryIdentity(presenceDir)).not.toBeNull();
  });
});

describe("record read safety (ISS-1022)", () => {
  it("treats a symlinked record as absent and replaces the LINK, not its target", () => {
    hook("SessionStart", { source: "startup" });
    const recordPath = join(presenceDir, `${SESSION}.json`);
    const target = join(root, "victim.json");
    writeFileSync(target, "IMPORTANT");
    rmSync(recordPath);
    symlinkSync(target, recordPath);

    expect(readBoundedNoFollow(recordPath)).toBeNull();
    expect(hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu_1" })).toBe("written");
    // rename() does not follow the link, so the victim is untouched...
    expect(readFileSync(target, "utf-8")).toBe("IMPORTANT");
    // ...and the record path is now a regular file again.
    expect(lstatSync(recordPath).isSymbolicLink()).toBe(false);
  });

  it.skipIf(process.platform === "win32")("treats a FIFO at the record path as absent and heals it", () => {
    mkdirSync(presenceDir, { recursive: true });
    const recordPath = join(presenceDir, `${SESSION}.json`);
    execFileSync("mkfifo", [recordPath]);
    expect(readBoundedNoFollow(recordPath)).toBeNull();
    expect(hook("SessionStart", { source: "startup" })).toBe("written");
    expect(lstatSync(recordPath).isFile()).toBe(true);
  });

  it("treats an oversized record as absent rather than loading it", () => {
    mkdirSync(presenceDir, { recursive: true });
    const recordPath = join(presenceDir, `${SESSION}.json`);
    writeFileSync(recordPath, "x".repeat(MAX_RECORD_BYTES + 1));
    expect(readBoundedNoFollow(recordPath)).toBeNull();
    expect(hook("SessionStart", { source: "startup" })).toBe("written");
    expect(readFileSync(recordPath, "utf-8").length).toBeLessThan(MAX_RECORD_BYTES);
  });

  it("treats a directory at the record path as absent", () => {
    mkdirSync(join(presenceDir, `${SESSION}.json`), { recursive: true });
    expect(readBoundedNoFollow(join(presenceDir, `${SESSION}.json`))).toBeNull();
  });
});

describe("record write safety (ISS-1022)", () => {
  it("reports a failed write when the target directory is not a real directory", () => {
    expect(atomicWriteInDir(join(root, "nope"), join(root, "nope", "a.json"), "{}")).toBe(false);
    const elsewhere = mkdtempSync(join(tmpdir(), "presence-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(root, "linkdir"), "dir");
      expect(atomicWriteInDir(join(root, "linkdir"), join(root, "linkdir", "a.json"), "{}")).toBe(false);
      expect(existsSync(join(elsewhere, "a.json"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // The post-rename identity check has its own file
  // (presence-write-postcheck.test.ts): proving it fires needs the directory
  // swapped DURING the rename, which needs node:fs mocked for the whole module.

  it("reports a failed write for a target that is not a direct child of the directory", () => {
    mkdirSync(presenceDir, { recursive: true });
    const outside = join(root, "outside.json");
    expect(atomicWriteInDir(presenceDir, outside, "{}")).toBe(false);
    expect(atomicWriteInDir(presenceDir, join(presenceDir, "nested", "a.json"), "{}")).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  /**
   * The unlink is documented as restricted to the revalidated directory, and
   * every call site happens to pass a child -- so without this, the helper
   * could delete any regular file on the machine and no test would notice.
   */
  it("never unlinks a file outside the revalidated directory", () => {
    mkdirSync(presenceDir, { recursive: true });
    const identity = directoryIdentity(presenceDir)!;
    const outside = join(root, "precious.json");
    writeFileSync(outside, "IMPORTANT");
    expect(removeRegularFile(presenceDir, outside, identity)).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe("IMPORTANT");
  });

  it("refuses removal keyed to a stale directory identity", () => {
    mkdirSync(presenceDir, { recursive: true });
    const stale = { dev: 1, ino: 999_999_999 };
    writeFileSync(join(presenceDir, "a.json"), "{}");
    expect(removeRegularFile(presenceDir, join(presenceDir, "a.json"), stale)).toBe(false);
    expect(removeRegularFile(presenceDir, join(presenceDir, "a.json"), directoryIdentity(presenceDir))).toBe(true);
  });

  it("never unlinks a directory or a symlink", () => {
    mkdirSync(presenceDir, { recursive: true });
    const identity = directoryIdentity(presenceDir)!;
    mkdirSync(join(presenceDir, "a-dir"));
    const victim = join(root, "victim.json");
    writeFileSync(victim, "IMPORTANT");
    symlinkSync(victim, join(presenceDir, "a-link.json"));

    expect(removeRegularFile(presenceDir, join(presenceDir, "a-dir"), identity)).toBe(false);
    expect(removeRegularFile(presenceDir, join(presenceDir, "a-link.json"), identity)).toBe(false);
    expect(existsSync(join(presenceDir, "a-dir"))).toBe(true);
    expect(readFileSync(victim, "utf-8")).toBe("IMPORTANT");
  });

  it("leaves no temp files behind on a successful write", () => {
    hook("SessionStart", { source: "startup" });
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu_1" });
    expect(readdirSync(presenceDir).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  });
});
