/**
 * ISS-1458: lsof is at /usr/sbin on macOS and at /usr/bin on Debian. macOS keeps
 * its one fixed path whatever PATH says; elsewhere lsof is found through PATH,
 * absolute entries only.
 *
 * ISS-1462: ps is found by the same rules, its fixed path /bin/ps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLsofPath, resolvePsPath, serveSeams } from "../../src/core/setup-verify-serve.js";

const MAC = "/usr/sbin/lsof";
const dirs: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "iss1458-"));
  dirs.push(d);
  return d;
};
const withTool = (name: string, mode = 0o755): string => {
  const d = dir();
  writeFileSync(join(d, name), "#!/bin/sh\n", { mode });
  return d;
};
const withLsof = (mode = 0o755): string => withTool("lsof", mode);
const withPs = (mode = 0o755): string => withTool("ps", mode);
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("where lsof is looked for", () => {
  it("macOS keeps its fixed path, even with an lsof first on PATH", () => {
    expect(resolveLsofPath("darwin", withLsof())).toBe(MAC);
  });

  it("macOS keeps its fixed path with no PATH at all", () => {
    expect(resolveLsofPath("darwin", undefined)).toBe(MAC);
  });

  it("Linux finds lsof through PATH, the first entry that has it", () => {
    const first = withLsof();
    const second = withLsof();
    const empty = dir();
    expect(resolveLsofPath("linux", [empty, first, second].join(":"))).toBe(join(first, "lsof"));
  });

  it("Linux never takes a relative PATH entry, which the project could fill", () => {
    const here = withLsof();
    const cwd = process.cwd();
    process.chdir(here);
    try {
      expect(resolveLsofPath("linux", ".:bin::")).toBe(MAC);
    } finally {
      process.chdir(cwd);
    }
  });

  it("Linux skips a file that cannot run and a directory named lsof", () => {
    const noExec = withLsof(0o644);
    const isDir = dir();
    mkdirSync(join(isDir, "lsof"));
    const good = withLsof();
    expect(resolveLsofPath("linux", [noExec, isDir, good].join(":"))).toBe(join(good, "lsof"));
  });

  it("no lsof on PATH falls back to the fixed path, so the check refuses as unsupported", () => {
    expect(resolveLsofPath("linux", dir())).toBe(MAC);
    expect(resolveLsofPath("linux", undefined)).toBe(MAC);
  });

  it("the seam the check reads is what the resolver answers on this platform", () => {
    expect(serveSeams.lsofPath).toBe(resolveLsofPath(process.platform, process.env.PATH));
    if (process.platform === "darwin") expect(serveSeams.lsofPath).toBe(MAC);
  });
});

describe("where ps is looked for (ISS-1462)", () => {
  const PS = "/bin/ps";
  it("macOS keeps its fixed path, even with a ps first on PATH", () => {
    expect(resolvePsPath("darwin", withPs())).toBe(PS);
  });

  it("macOS keeps its fixed path with no PATH at all", () => {
    expect(resolvePsPath("darwin", undefined)).toBe(PS);
  });

  it("Linux finds ps through PATH, the first entry that has it", () => {
    const first = withPs();
    const second = withPs();
    const empty = dir();
    expect(resolvePsPath("linux", [empty, first, second].join(":"))).toBe(join(first, "ps"));
  });

  it("Linux never takes a relative PATH entry, which the project could fill", () => {
    const here = withPs();
    mkdirSync(join(here, "bin"));
    writeFileSync(join(here, "bin", "ps"), "#!/bin/sh\n", { mode: 0o755 });
    const cwd = process.cwd();
    process.chdir(here);
    try {
      expect(resolvePsPath("linux", ".:bin::")).toBe(PS);
    } finally {
      process.chdir(cwd);
    }
  });

  it("Linux skips a file that cannot run and a directory named ps", () => {
    const noExec = withPs(0o644);
    const isDir = dir();
    mkdirSync(join(isDir, "ps"));
    const good = withPs();
    expect(resolvePsPath("linux", [noExec, isDir, good].join(":"))).toBe(join(good, "ps"));
  });

  it("no ps on PATH falls back to the fixed path, so the check refuses as unsupported", () => {
    expect(resolvePsPath("linux", dir())).toBe(PS);
    expect(resolvePsPath("linux", undefined)).toBe(PS);
  });

  it("the seam the run reads is what the resolver answers on this platform", () => {
    expect(serveSeams.psPath).toBe(resolvePsPath(process.platform, process.env.PATH));
    if (process.platform === "darwin") expect(serveSeams.psPath).toBe(PS);
  });
});
