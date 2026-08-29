import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import * as nodeFs from "node:fs";

// ESM module namespaces are non-configurable, so `vi.spyOn(nodeFs, "readdirSync")`
// cannot redefine the export directly. `readdirSafe`'s two lstatSync/readdirSync
// races are simulated instead via a mockable override this file controls,
// falling through to the real implementation when no override is set.
// `var`, not `let`/`const`: `vi.mock`'s factory is hoisted above this file's
// own statements and can run before a `let` binding here would leave its
// temporal dead zone, throwing "Cannot access before initialization". `var`
// is function/module-scoped and initialized to `undefined` immediately, so
// the factory (and the overrides it reads) can reference these safely
// regardless of execution order.
var readdirSyncOverride: typeof nodeFs.readdirSync | undefined;
var lstatSyncOverride: typeof nodeFs.lstatSync | undefined;
// The real, unwrapped implementations -- captured once, at mock-definition
// time, so an override's own fallback branch calls the TRUE original rather
// than recursing back into this wrapper (which `nodeFs.lstatSync` inside a
// test would do, since `nodeFs` is bound to the mocked module everywhere).
var realReaddirSync: typeof nodeFs.readdirSync;
var realLstatSync: typeof nodeFs.lstatSync;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  realReaddirSync = actual.readdirSync;
  realLstatSync = actual.lstatSync;
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof nodeFs.readdirSync>) =>
      readdirSyncOverride ? readdirSyncOverride(...(args as [never])) : (actual.readdirSync as (...a: unknown[]) => unknown)(...args),
    lstatSync: (...args: Parameters<typeof nodeFs.lstatSync>) =>
      lstatSyncOverride ? lstatSyncOverride(...(args as [never])) : (actual.lstatSync as (...a: unknown[]) => unknown)(...args),
  };
});

const { readdirSafe, verifyContainment, verifyDirIdentity } = await import("../../src/core/readdir-safe.js");

describe("readdirSafe", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "readdir-safe-"));
  });

  afterEach(async () => {
    readdirSyncOverride = undefined;
    lstatSyncOverride = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("returns dirents: null, warning: null for a missing directory (ordinary pre-feature-adoption state)", () => {
    const result = readdirSafe(join(root, "does-not-exist"));
    expect(result.dirents).toBeNull();
    expect(result.dirIdentity).toBeNull();
    expect(result.warning).toBeNull();
  });

  it.skipIf(platform() === "win32")("refuses to enumerate a symlinked directory", async () => {
    const real = join(root, "real");
    await mkdir(real, { recursive: true });
    const link = join(root, "link");
    await symlink(real, link);
    const result = readdirSafe(link);
    expect(result.dirents).toBeNull();
    expect(result.warning).toMatch(/is a symlink/);
  });

  it("refuses to enumerate a path that is not a directory", async () => {
    const file = join(root, "notadir");
    await writeFile(file, "x");
    const result = readdirSafe(file);
    expect(result.dirents).toBeNull();
    expect(result.warning).toMatch(/is not a directory/);
  });

  it("lists a real directory and returns a dirIdentity token", async () => {
    const dir = join(root, "d");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.json"), "{}");
    const result = readdirSafe(dir);
    expect(result.warning).toBeNull();
    expect(result.dirents).toHaveLength(1);
    expect(result.dirIdentity).not.toBeNull();
    expect(typeof result.dirIdentity?.dev).toBe("number");
    expect(typeof result.dirIdentity?.ino).toBe("number");
  });

  it("reports a distinct warning when readdirSync ENOENTs AFTER the first lstat already proved the directory existed (a real race, not the ordinary missing-directory case)", async () => {
    const dir = join(root, "raced");
    await mkdir(dir, { recursive: true });
    readdirSyncOverride = (() => {
      const err = new Error("ENOENT: no such file or directory, scandir") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as typeof nodeFs.readdirSync;
    const result = readdirSafe(dir);
    expect(result.dirents).toBeNull();
    expect(result.warning).toBe("was removed during enumeration");
  });

  it("discards the listing when the directory's identity changes between the two lstat calls (dev/ino mismatch)", async () => {
    const dir = join(root, "swapped");
    await mkdir(dir, { recursive: true });
    const other = join(root, "other");
    await mkdir(other, { recursive: true });
    const otherStat = realLstatSync(other);
    let call = 0;
    lstatSyncOverride = ((p: nodeFs.PathLike, opts?: unknown) => {
      call += 1;
      // First call (pre-listing) sees the real directory; second call
      // (post-listing) reports a DIFFERENT identity, simulating a swap.
      if (call === 2) return otherStat;
      return realLstatSync(p, opts as never);
    }) as typeof nodeFs.lstatSync;
    const result = readdirSafe(dir);
    expect(result.dirents).toBeNull();
    expect(result.warning).toMatch(/identity changed during enumeration/);
  });
});

describe("verifyDirIdentity", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-dir-identity-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns null when the directory's identity is unchanged", async () => {
    const dir = join(root, "d");
    await mkdir(dir, { recursive: true });
    const scan = readdirSafe(dir);
    expect(scan.dirIdentity).not.toBeNull();
    expect(verifyDirIdentity(dir, scan.dirIdentity!)).toBeNull();
  });

  it("reports a warning when the directory vanished after enumeration", async () => {
    const dir = join(root, "d");
    await mkdir(dir, { recursive: true });
    const scan = readdirSafe(dir);
    await rm(dir, { recursive: true, force: true });
    expect(verifyDirIdentity(dir, scan.dirIdentity!)).toMatch(/vanished after enumeration/);
  });

  it("reports a warning when the directory's identity differs from what was captured (persistent swap, still in effect)", async () => {
    const dir = join(root, "d");
    await mkdir(dir, { recursive: true });
    const scan = readdirSafe(dir);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true }); // a fresh directory at the same path has a different inode
    expect(verifyDirIdentity(dir, scan.dirIdentity!)).toMatch(/identity changed after enumeration/);
  });

  it("does NOT detect a swap that occurs and reverts before this check runs (documented, irreducible limitation)", async () => {
    // This test intentionally proves the LIMITATION named in the module's
    // own doc comment, not a bug: a swap that fully reverts before
    // verifyDirIdentity runs restores the original dev/ino, so this check
    // reports a match -- exactly the residual gap the honest-limitation
    // text in the plan retracted an earlier overclaim about.
    const dir = join(root, "d");
    await mkdir(dir, { recursive: true });
    const scan = readdirSafe(dir);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    // Recreate a THIRD time to land back at a state indistinguishable from
    // the original as far as a single dev/ino comparison can tell (a fresh
    // directory reusing a freed inode is filesystem-dependent and not
    // reliably reproducible in a portable test; instead this test documents
    // the claim structurally: verifyDirIdentity has no mechanism beyond
    // dev/ino comparison, so any recreate that lands on the ORIGINAL inode
    // is undetectable by construction). We assert the mechanism's own
    // limitation directly rather than trying to force a specific inode
    // collision.
    await mkdir(dir, { recursive: true });
    const finalStat = nodeFs.lstatSync(dir);
    const wouldBeUndetected = finalStat.dev === scan.dirIdentity!.dev && finalStat.ino === scan.dirIdentity!.ino;
    // Either this specific run happened to reuse the inode (proving the gap
    // directly) or it didn't (filesystem-dependent) -- in the latter case we
    // still assert the documented behavior holds for a constructed match.
    if (wouldBeUndetected) {
      expect(verifyDirIdentity(dir, scan.dirIdentity!)).toBeNull();
    } else {
      expect(verifyDirIdentity(dir, { dev: finalStat.dev, ino: finalStat.ino })).toBeNull();
    }
  });
});

describe("verifyContainment", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-containment-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns null for an ordinary regular file contained in dir", async () => {
    const dir = join(root, ".story", "arrangements");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.json"), "{}");
    expect(verifyContainment(dir, "a.json")).toBeNull();
  });

  it("does not false-positive when an ancestor path component is itself a symlink normalized by realpath (e.g. macOS /var -> /private/var), as long as dir and the file resolve consistently", async () => {
    // root itself, under macOS's tmpdir(), already exercises this case for
    // every other test in this file; this test names the property
    // explicitly so a regression here is caught by its own failure message
    // rather than as a mysterious failure in an unrelated loader test.
    const dir = join(root, ".story", "rulings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "r-aaaaaaaaaaaaaaaa.json"), "{}");
    expect(verifyContainment(dir, "r-aaaaaaaaaaaaaaaa.json")).toBeNull();
  });

  it.skipIf(platform() === "win32")(
    "flags a symlink whose target escapes dir via a SIBLING directory whose name string-prefixes dir's name (proves the path.relative fix, not string-prefix)",
    async () => {
      // dir = ".../bar"; sibling = ".../bar-evil". A naive
      // resolvedFile.startsWith(dir) check would wrongly accept a target
      // under bar-evil, since the string "bar-evil" starts with "bar".
      const dir = join(root, "bar");
      const evilSibling = join(root, "bar-evil");
      await mkdir(dir, { recursive: true });
      await mkdir(evilSibling, { recursive: true });
      await writeFile(join(evilSibling, "secret.json"), "{}");
      await symlink(join(evilSibling, "secret.json"), join(dir, "a.json"));
      const result = verifyContainment(dir, "a.json");
      expect(result).toMatch(/resolved outside/);
    },
  );

  it.skipIf(platform() === "win32")("flags a symlink whose target is a genuinely unrelated directory", async () => {
    const dir = join(root, ".story", "arrangements");
    const outside = join(root, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "x.json"), "{}");
    await symlink(join(outside, "x.json"), join(dir, "a.json"));
    expect(verifyContainment(dir, "a.json")).toMatch(/resolved outside/);
  });

  it("reports a warning, not a throw, when the entry vanishes between listing and this check", async () => {
    const dir = join(root, ".story", "arrangements");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.json"), "{}");
    await unlink(join(dir, "a.json"));
    expect(() => verifyContainment(dir, "a.json")).not.toThrow();
    expect(verifyContainment(dir, "a.json")).toMatch(/Could not resolve/);
  });
});
