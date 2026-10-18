/**
 * ISS-1399: the directory sync helper and the one list of codes that mean a
 * filesystem cannot sync a directory at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ syncError: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: unknown[]) => {
    const handle = await (actual.open as (...a: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(...args);
    if (seam.syncError === null) return handle;
    const code = seam.syncError;
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === "sync") return async () => {
          throw Object.assign(new Error(`${code}: injected directory sync`), { code });
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

const { isDirSyncUnsupported, syncDir } = await import("../../src/core/durable-dir.js");

const dirs: string[] = [];
afterEach(() => {
  seam.syncError = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "iss1399-dir-"));
  dirs.push(d);
  return d;
}

const coded = (code: string) => Object.assign(new Error(code), { code });

describe("ISS-1399: syncDir", () => {
  it("syncs a real directory", async () => {
    await expect(syncDir(dir())).resolves.toBeUndefined();
  });

  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])("returns when the filesystem answers %s", async (code) => {
    seam.syncError = code;
    await expect(syncDir(dir())).resolves.toBeUndefined();
  });

  it("throws a real failure", async () => {
    seam.syncError = "EIO";
    await expect(syncDir(dir())).rejects.toThrow(/EIO/);
  });

  it("throws when the directory is missing", async () => {
    await expect(syncDir(join(dir(), "missing"))).rejects.toThrow(/ENOENT/);
  });
});

describe("ISS-1399: isDirSyncUnsupported", () => {
  it("knows EISDIR and EPERM only on win32", () => {
    for (const code of ["EISDIR", "EPERM"]) {
      expect(isDirSyncUnsupported(coded(code), "win32")).toBe(true);
      expect(isDirSyncUnsupported(coded(code), "darwin")).toBe(false);
    }
    expect(isDirSyncUnsupported(coded("EIO"), "win32")).toBe(false);
    expect(isDirSyncUnsupported(null)).toBe(false);
  });
});
