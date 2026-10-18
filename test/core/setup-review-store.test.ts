/**
 * T-536: the store's durability primitives. A directory sync that fails for a
 * real reason is a failure the caller sees; only a filesystem that cannot sync
 * a directory at all is tolerated.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncDir, writeFileDurable } from "../../src/core/setup-review.js";

const err = (code: string) => (): never => { throw Object.assign(new Error(`${code}: fsync`), { code }); };
const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sr-store-prim-"));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("setup review store durability (T-536)", () => {
  it("fsyncDir propagates EIO and tolerates only a filesystem that cannot sync a directory", () => {
    const dir = scratch();
    expect(() => fsyncDir(dir, err("EIO"))).toThrow(/EIO/);
    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP"]) expect(() => fsyncDir(dir, err(code))).not.toThrow();
    expect(() => fsyncDir(join(dir, "missing"))).toThrow();
    expect(() => fsyncDir(dir)).not.toThrow();
  });

  it("writeFileDurable syncs the parent directory after the rename and reports its failure", () => {
    const dir = scratch();
    const file = join(dir, "setup.json");
    let syncs = 0;
    expect(() => writeFileDurable(file, "x", (fd) => { if (++syncs === 2) err("EIO")(); void fd; })).toThrow(/EIO/);
    expect(syncs).toBe(2);
    expect(readFileSync(file, "utf-8")).toBe("x");
    let ok = 0;
    writeFileDurable(file, "y", () => { ok++; });
    expect(ok).toBe(2);
  });
});
