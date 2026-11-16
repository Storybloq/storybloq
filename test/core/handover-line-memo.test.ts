/**
 * ISS-1499 slice B, commit 2: the session memo, read side (plan section 4).
 * B1 decoding and safety, the read-side rows of B2 (recovery by digest),
 * and `telemetrySubdirState`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Records every path the fs layer is asked to look at, so B1 can prove no
// path outside the handovers and memo folders is ever opened.
const seen = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrap = <T extends (...a: never[]) => unknown>(fn: T): T =>
    ((...a: unknown[]) => { if (typeof a[0] === "string") seen.paths.push(a[0]); return (fn as unknown as (...b: unknown[]) => unknown)(...a); }) as unknown as T;
  const m = { ...real, lstatSync: wrap(real.lstatSync), openSync: wrap(real.openSync), statSync: wrap(real.statSync), readFileSync: wrap(real.readFileSync) };
  return { ...m, default: m };
});

import {
  LINE_MEMO_MAX_BYTES,
  decodeLineMemo,
  digestBytes,
  hashHandoverFile,
  isMemoFile,
  memoFileName,
  memoSeams,
  resolveLineMemo,
} from "../../src/core/handover-line-memo.js";
import { TailReader } from "../../src/core/handover-selection.js";
import { telemetrySubdirState } from "../../src/presence/io.js";

const TASK = "task-a.1";
const OTHER = "task-b.2";
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

let base: string;
let root: string;
let hdir: string;
let mdir: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "line-memo-")));
  root = join(base, "proj");
  hdir = join(root, ".story", "handovers");
  mdir = join(root, ".story", "telemetry", "handover-lines");
  mkdirSync(hdir, { recursive: true });
  seen.paths = [];
  memoSeams.afterHashFstat = null;
});
afterEach(() => {
  memoSeams.afterHashFstat = null;
  rmSync(base, { recursive: true, force: true });
});

const memoJson = (o: Record<string, unknown>): string => JSON.stringify(o);
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, task: TASK, tip: "2026-11-10-01-a.md", writing: null, ...over });

function writeMemo(text: string, task = TASK): void {
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, memoFileName(task)), text);
}

function handover(name: string, body: string | Buffer): void {
  writeFileSync(join(hdir, name), body);
}

const tails = (): TailReader => {
  const names = (execFileSync("ls", ["-1A", hdir], { encoding: "utf8" }).split("\n").filter(Boolean)).sort().reverse();
  return new TailReader(hdir, names);
};

describe("memo file name and MemoFile", () => {
  it("is the SHA-256 hex of the identity plus .json", () => {
    expect(memoFileName(TASK)).toBe(`${sha(TASK)}.json`);
  });

  it("a MemoFile passes the FILE value rule and the brief admission", () => {
    expect(isMemoFile("2026-11-10-01-a.md")).toBe(true);
    for (const bad of ["a/b.md", "../a.md", "a..b.md", "a.txt", "x".repeat(253) + ".md", "", 7, null, "café.md", 'a"b.md']) {
      expect(isMemoFile(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isMemoFile("x".repeat(252) + ".md")).toBe(true);
  });
});

describe("B1 decoding", () => {
  it("accepts exactly the four keys with valid values", () => {
    expect(decodeLineMemo(memoJson(good()), TASK)).toEqual(good());
    expect(decodeLineMemo(memoJson(good({ tip: null })), TASK)).toEqual(good({ tip: null }));
    const w = { file: "2026-11-11-01-b.md", sha256: "a".repeat(64) };
    expect(decodeLineMemo(memoJson(good({ writing: w })), TASK)).toEqual(good({ writing: w }));
  });

  const cases: Array<[string, string]> = [
    ["not JSON", "{"],
    ["an array", "[]"],
    ["wrong v", memoJson(good({ v: 2 }))],
    ["v as a string", memoJson(good({ v: "1" }))],
    ["task mismatch", memoJson(good({ task: OTHER }))],
    ["extra key", memoJson({ ...good(), extra: 1 })],
    ["missing writing", memoJson({ v: 1, task: TASK, tip: null })],
    ["tip with a slash", memoJson(good({ tip: "a/b.md" }))],
    ["tip with ..", memoJson(good({ tip: "..a.md" }))],
    ["tip without .md", memoJson(good({ tip: "a.txt" }))],
    ["tip over 255 bytes", memoJson(good({ tip: "x".repeat(253) + ".md" }))],
    ["tip a number", memoJson(good({ tip: 3 }))],
    ["writing a string", memoJson(good({ writing: "x" }))],
    ["writing extra key", memoJson(good({ writing: { file: "a.md", sha256: "a".repeat(64), x: 1 } }))],
    ["writing file invalid", memoJson(good({ writing: { file: "../a.md", sha256: "a".repeat(64) } }))],
    ["short digest", memoJson(good({ writing: { file: "a.md", sha256: "a".repeat(63) } }))],
    ["uppercase digest", memoJson(good({ writing: { file: "a.md", sha256: "A".repeat(64) } }))],
  ];
  for (const [name, text] of cases) {
    it(`no memo: ${name}`, () => {
      expect(decodeLineMemo(text, TASK)).toBeNull();
    });
  }
});

describe("B1 resolving: safety", () => {
  it("no identity, no folder, no file: none, and nothing is observed", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    for (const task of [null, TASK]) {
      const t = tails();
      expect(resolveLineMemo(root, task, t)).toEqual({ kind: "none" });
      expect(t.observation.seen).toBe(false);
    }
    mkdirSync(mdir, { recursive: true });
    const t = tails();
    expect(resolveLineMemo(root, TASK, t)).toEqual({ kind: "none" });
    expect(t.observation.seen).toBe(false);
  });

  it("a memo over 2,048 bytes is no memo", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    const text = memoJson(good());
    writeMemo(text + " ".repeat(LINE_MEMO_MAX_BYTES - text.length + 1));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
    writeMemo(text + " ".repeat(LINE_MEMO_MAX_BYTES - text.length));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-10-01-a.md" });
  });

  it("a memo naming a path outside the folder never opens it", () => {
    const outside = join(base, "outside.md");
    writeFileSync(outside, "# Outside\n");
    for (const tip of ["../../../outside.md", "/etc/passwd.md", "..outside.md"]) {
      writeMemo(memoJson(good({ tip, writing: { file: tip, sha256: sha("# Outside\n") } })));
      seen.paths = [];
      expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
      for (const p of seen.paths) {
        expect(p.startsWith(hdir + "/") || p === hdir || p.startsWith(join(root, ".story")), p).toBe(true);
        expect(p).not.toContain("outside");
        expect(p).not.toContain("passwd");
      }
    }
  });

  it("a symlinked memo file, a symlinked telemetry or handover-lines folder: no memo", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, memoFileName(TASK)), memoJson(good()));
    // The memo file itself is a symlink.
    mkdirSync(mdir, { recursive: true });
    symlinkSync(join(elsewhere, memoFileName(TASK)), join(mdir, memoFileName(TASK)));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
    // The handover-lines folder is a symlink.
    rmSync(mdir, { recursive: true });
    symlinkSync(elsewhere, mdir);
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
    // The telemetry folder is a symlink.
    rmSync(join(root, ".story", "telemetry"), { recursive: true });
    const tele = join(base, "tele");
    mkdirSync(join(tele, "handover-lines"), { recursive: true });
    writeFileSync(join(tele, "handover-lines", memoFileName(TASK)), memoJson(good()));
    symlinkSync(tele, join(root, ".story", "telemetry"));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
  });

  it("a FIFO in place of the memo: no memo, no hang", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    mkdirSync(mdir, { recursive: true });
    execFileSync("mkfifo", [join(mdir, memoFileName(TASK))]);
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
  });

  it("one identity never reads another's memo", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    writeMemo(memoJson(good()), TASK);
    expect(resolveLineMemo(root, OTHER, tails())).toEqual({ kind: "none" });
    // A copy of A's memo under B's file name still names task A.
    writeMemo(memoJson(good()), OTHER);
    expect(resolveLineMemo(root, OTHER, tails())).toEqual({ kind: "none" });
  });
});

describe("resolving: active and stale", () => {
  it("a tip that is linked or unlinked is active, and the memo is observed", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    writeMemo(memoJson(good()));
    const t = tails();
    expect(resolveLineMemo(root, TASK, t)).toEqual({ kind: "active", tip: "2026-11-10-01-a.md" });
    expect(t.observation.seen).toBe(true);
  });

  it("a tip not in the folder is stale missing; an unreadable tip is stale unreadable; both observed", () => {
    writeMemo(memoJson(good()));
    let t = tails();
    expect(resolveLineMemo(root, TASK, t)).toEqual({ kind: "stale", tip: "2026-11-10-01-a.md", reason: "missing" });
    expect(t.observation.seen).toBe(true);
    mkdirSync(join(hdir, "2026-11-10-01-a.md"));
    t = tails();
    expect(resolveLineMemo(root, TASK, t)).toEqual({ kind: "stale", tip: "2026-11-10-01-a.md", reason: "unreadable" });
    expect(t.observation.seen).toBe(true);
  });

  it("tip null with no intent is none, but a decoded memo is still observed", () => {
    writeMemo(memoJson(good({ tip: null })));
    const t = tails();
    expect(resolveLineMemo(root, TASK, t)).toEqual({ kind: "none" });
    expect(t.observation.seen).toBe(true);
  });

  it("a read never writes the memo, even when it adopts the intent", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    handover("2026-11-11-01-b.md", "# B\n");
    // A matching intent: resolution adopts it, the case most tempted to persist.
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-b.md", sha256: sha("# B\n") } })));
    const path = join(mdir, memoFileName(TASK));
    const snap = () => {
      const st = statSync(path);
      return { bytes: readFileSync(path), mtimeMs: st.mtimeMs, ino: st.ino, size: st.size };
    };
    const before = snap();
    const names = readdirSync(mdir);
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-11-01-b.md" });
    expect(snap()).toEqual(before);
    expect(readdirSync(mdir)).toEqual(names);
  });
});

describe("B2 read side: recovery by digest", () => {
  it("an intent whose file matches its digest is the effective tip", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    handover("2026-11-11-01-b.md", "# B\n");
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-b.md", sha256: sha("# B\n") } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-11-01-b.md" });
  });

  it("an intent whose file does not exist yet leaves the old tip standing", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-b.md", sha256: sha("# B\n") } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-10-01-a.md" });
  });

  it("an intent with tip null and no file is none", () => {
    writeMemo(memoJson(good({ tip: null, writing: { file: "2026-11-11-01-b.md", sha256: sha("# B\n") } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "none" });
  });

  it("a name later reused with other bytes is not adopted", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    handover("2026-11-11-01-b.md", "# B, rewritten by someone else\n");
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-b.md", sha256: sha("# B\n") } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-10-01-a.md" });
  });

  it("a handover larger than 2 KB is healed by the whole-file digest, not a tail", () => {
    const body = "# Big\n\n" + "line of text\n".repeat(400);
    expect(Buffer.byteLength(body)).toBeGreaterThan(2048);
    handover("2026-11-10-01-a.md", "# A\n");
    handover("2026-11-11-01-big.md", body);
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-big.md", sha256: sha(body) } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-11-01-big.md" });
    // A digest of the final 2,048 bytes is not accepted.
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-big.md", sha256: sha(Buffer.from(body).subarray(-2048)) } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-10-01-a.md" });
  });

  it("a handover of 8,388,609 bytes is healed (no size cap)", () => {
    const big = Buffer.alloc(8_388_609, 0x61);
    handover("2026-11-10-01-a.md", "# A\n");
    handover("2026-11-11-01-huge.md", big);
    writeMemo(memoJson(good({ writing: { file: "2026-11-11-01-huge.md", sha256: sha(big) } })));
    expect(resolveLineMemo(root, TASK, tails())).toEqual({ kind: "active", tip: "2026-11-11-01-huge.md" });
  });

  it("a file that grows after fstat is hashed to its fstat size only", () => {
    const body = "# B\n" + "z".repeat(70_000);
    handover("2026-11-11-01-b.md", body);
    memoSeams.afterHashFstat = (p) => appendFileSync(p, "grown");
    expect(hashHandoverFile(hdir, "2026-11-11-01-b.md")).toBe(sha(body));
  });

  it("the file digest and the bytes digest are the same function", () => {
    const body = Buffer.from("# B\n" + "q".repeat(200_000));
    handover("2026-11-11-01-b.md", body);
    expect(digestBytes(body)).toBe(sha(body));
    expect(hashHandoverFile(hdir, "2026-11-11-01-b.md")).toBe(digestBytes(body));
  });

  it("hashHandoverFile refuses a symlink, a directory, a FIFO and a missing name", () => {
    handover("2026-11-10-01-a.md", "# A\n");
    symlinkSync("2026-11-10-01-a.md", join(hdir, "link.md"));
    mkdirSync(join(hdir, "dir.md"));
    execFileSync("mkfifo", [join(hdir, "fifo.md")]);
    for (const n of ["link.md", "dir.md", "fifo.md", "missing.md"]) expect(hashHandoverFile(hdir, n), n).toBeNull();
  });
});

describe("telemetrySubdirState", () => {
  it("absent at the first missing level, present when all three are real directories", () => {
    rmSync(join(root, ".story"), { recursive: true });
    expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "absent" });
    mkdirSync(join(root, ".story"));
    expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "absent" });
    mkdirSync(join(root, ".story", "telemetry"));
    expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "absent" });
    mkdirSync(mdir);
    expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "present", dir: mdir });
  });

  it("unsafe for a symlink or a file at any level", () => {
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, mdir);
    expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "unsafe" });
    rmSync(mdir);
    writeFileSync(mdir, "");
    expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "unsafe" });
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("unsafe when a level cannot be inspected", () => {
    mkdirSync(mdir, { recursive: true });
    chmodSync(join(root, ".story"), 0o000);
    try {
      expect(telemetrySubdirState(root, "handover-lines")).toEqual({ state: "unsafe" });
    } finally {
      chmodSync(join(root, ".story"), 0o755);
    }
  });

  it("unsafe for a name outside the portable shape", () => {
    expect(telemetrySubdirState(root, "../x")).toEqual({ state: "unsafe" });
  });
});
