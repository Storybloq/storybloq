/**
 * ISS-1499 slice A: the tail read from disk (plan 3.2a). The file side of A2
 * (a file and a string with the same bytes agree), and the refusal of every
 * entry that is not a regular file: no symlink is followed, even one that
 * stays inside the folder, and a FIFO never blocks the scan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLineage } from "../../src/core/handover-lineage.js";
import { scanHandoverFile, scanHandoverLineage } from "../../src/core/handover-lineage-scan.js";
import { LINE, TAIL_SHAPES } from "../fixtures/handover-lineage/shapes.js";

// A counting passthrough of node:fs: every call reaches the real function, and
// the bounded-I/O tests read what the scan asked for.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const spy = <F extends (...a: never[]) => unknown>(f: F) => vi.fn(f);
  const m = {
    ...real,
    lstatSync: spy(real.lstatSync),
    statSync: spy(real.statSync),
    openSync: spy(real.openSync),
    readSync: spy(real.readSync),
    readFileSync: spy(real.readFileSync),
    createReadStream: spy(real.createReadStream),
  };
  return { ...m, default: m };
});

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lineage-scan-")));
});
afterEach(() => {
  try { chmodSync(join(dir, "locked.md"), 0o644); } catch { /* not created */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("A2 tail rule, file side", () => {
  it.each(TAIL_SHAPES.map((s) => [s.name, s] as const))("%s: the file and the string agree", (_n, shape) => {
    writeFileSync(join(dir, "h.md"), shape.bytes);
    const f = scanHandoverFile(dir, "h.md");
    expect(f.state).toBe(shape.linked ? "linked" : "unlinked");
    const s = readLineage(shape.bytes.toString("utf8"));
    expect(s.kind).toBe(f.state);
    if (s.kind === "linked") expect(f.lineage).toEqual(s.parsed);
  });

  it("an unlinked file whose final line starts like a v1 line is a near miss", () => {
    writeFileSync(join(dir, "a.md"), "# T\n\n<!-- storybloq-lineage v1 continues=a.md -->\n");
    writeFileSync(join(dir, "b.md"), "# T\n\n<!-- storybloq-lineage v10 -->\n");
    writeFileSync(join(dir, "c.md"), "# T\n");
    expect(scanHandoverFile(dir, "a.md")).toEqual({ name: "a.md", state: "unlinked", nearMiss: true });
    expect(scanHandoverFile(dir, "b.md")).toEqual({ name: "b.md", state: "unlinked", nearMiss: false });
    expect(scanHandoverFile(dir, "c.md")).toEqual({ name: "c.md", state: "unlinked", nearMiss: false });
  });
});

describe("3.2a entries that are not regular files", () => {
  it("a symlink that stays inside the folder is not followed", () => {
    writeFileSync(join(dir, "real.md"), "# T\n\n" + LINE + "\n");
    symlinkSync(join(dir, "real.md"), join(dir, "link.md"));
    symlinkSync("real.md", join(dir, "rel-link.md"));
    expect(scanHandoverFile(dir, "real.md").state).toBe("linked");
    expect(scanHandoverFile(dir, "link.md")).toEqual({ name: "link.md", state: "unknown", reason: "not_regular" });
    expect(scanHandoverFile(dir, "rel-link.md")).toEqual({ name: "rel-link.md", state: "unknown", reason: "not_regular" });
  });

  it("a symlink pointing outside the folder, a directory, and a dangling symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "lineage-out-"));
    try {
      writeFileSync(join(outside, "o.md"), "# T\n\n" + LINE + "\n");
      symlinkSync(join(outside, "o.md"), join(dir, "out.md"));
      mkdirSync(join(dir, "x.md"));
      symlinkSync(join(dir, "nowhere.md"), join(dir, "dangling.md"));
      expect(scanHandoverFile(dir, "out.md")).toEqual({ name: "out.md", state: "unknown", reason: "not_regular" });
      expect(scanHandoverFile(dir, "x.md")).toEqual({ name: "x.md", state: "unknown", reason: "not_regular" });
      expect(scanHandoverFile(dir, "dangling.md")).toEqual({ name: "dangling.md", state: "unknown", reason: "not_regular" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a name over the admission limit is refused without touching the disk", () => {
    const name = "a".repeat(300) + ".md";
    expect(scanHandoverFile(dir, name)).toEqual({ name, state: "unknown", reason: "name_too_long" });
  });

  it("a listed file that has disappeared is unreadable", () => {
    expect(scanHandoverFile(dir, "gone.md")).toEqual({ name: "gone.md", state: "unknown", reason: "unreadable" });
  });

  it.skipIf(process.getuid?.() === 0)("a file without read permission is unreadable", () => {
    writeFileSync(join(dir, "locked.md"), "# T\n");
    chmodSync(join(dir, "locked.md"), 0o000);
    expect(scanHandoverFile(dir, "locked.md")).toEqual({ name: "locked.md", state: "unknown", reason: "unreadable" });
  });

  it("a FIFO as the newest entry is refused, and the scan returns without blocking (child process, external deadline)", () => {
    writeFileSync(join(dir, "2026-11-12-01-old.md"), "# old\n");
    expect(spawnSync("mkfifo", [join(dir, "2026-11-13-01-pipe.md")]).status).toBe(0);
    const script = join(dir, "..", `lineage-fifo-${process.pid}-${Date.now()}.mts`);
    writeFileSync(
      script,
      `import { scanHandoverLineage } from ${JSON.stringify(join(pkgRoot, "src/core/handover-lineage-scan.ts"))};\n` +
        `const r = scanHandoverLineage(${JSON.stringify(dir)}, ["2026-11-13-01-pipe.md", "2026-11-12-01-old.md"], true);\n` +
        "process.stdout.write(JSON.stringify(r));\n",
    );
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: pkgRoot, timeout: 20_000, encoding: "utf8" });
      expect(r.error, "the scan blocked past the deadline").toBeUndefined();
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        files: [
          { name: "2026-11-13-01-pipe.md", state: "unknown", reason: "not_regular" },
          { name: "2026-11-12-01-old.md", state: "unlinked", nearMiss: false },
        ],
        enumerated: true,
        complete: false,
      });
    } finally {
      rmSync(script, { force: true });
    }
  }, 30_000);
});

describe("scan result", () => {
  it("is complete only when enumerated and every file was read", () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    writeFileSync(join(dir, "b.md"), "# b\n\n" + LINE + "\n");
    expect(scanHandoverLineage(dir, ["b.md", "a.md"], true)).toEqual({
      files: [
        { name: "b.md", state: "linked", lineage: readLineage("# b\n\n" + LINE + "\n").kind === "linked" ? (readLineage("# b\n\n" + LINE + "\n") as { parsed: unknown }).parsed : null },
        { name: "a.md", state: "unlinked", nearMiss: false },
      ],
      enumerated: true,
      complete: true,
    });
    expect(scanHandoverLineage(dir, ["a.md", "gone.md"], true).complete).toBe(false);
    expect(scanHandoverLineage(dir, [], false)).toEqual({ files: [], enumerated: false, complete: false });
  });
});

describe("3.2a bounded I/O", () => {
  const io = async () => {
    const fs = await import("node:fs");
    return {
      lstat: vi.mocked(fs.lstatSync), stat: vi.mocked(fs.statSync), open: vi.mocked(fs.openSync),
      read: vi.mocked(fs.readSync), readFile: vi.mocked(fs.readFileSync), stream: vi.mocked(fs.createReadStream),
    };
  };
  const clear = async () => { for (const f of Object.values(await io())) f.mockClear(); };

  it("a large regular file is read with at most 2,048 bytes, all from offset size minus 2,048", async () => {
    const big = Buffer.concat([Buffer.from("# T\n\n" + "x".repeat(200_000) + "\n\n"), Buffer.from(LINE + "\n")]);
    writeFileSync(join(dir, "big.md"), big);
    await clear();
    const f = scanHandoverFile(dir, "big.md");
    expect(f.state).toBe("linked");
    const { read, readFile, stream, open } = await io();
    expect(readFile).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.length).toBeGreaterThan(0);
    let total = 0;
    for (const call of read.mock.calls) {
      const [, , , length, position] = call as unknown as [number, Buffer, number, number, number];
      expect(typeof position).toBe("number");
      expect(position).toBeGreaterThanOrEqual(big.length - 2048);
      total += length;
    }
    expect(total).toBeLessThanOrEqual(2048);
  });

  it("an inadmissible name causes no lstat, stat, open or read", async () => {
    await clear();
    const f = scanHandoverFile(dir, "x".repeat(5000) + ".md");
    expect(f).toEqual({ name: "x".repeat(5000) + ".md", state: "unknown", reason: "name_too_long" });
    const { lstat, stat, open, read, readFile, stream } = await io();
    for (const fn of [lstat, stat, open, read, readFile, stream]) expect(fn).not.toHaveBeenCalled();
  });
});
