/**
 * T-538 signed-in note v5 section 12, S4: the subprocess environments. Env table rows b (pgrep counts), d (the
 * clients' --version), g (the run and judge children) and h (the run's identity git calls) are explicit, and the
 * HOME fallbacks for the Codex auth path are gone. One row per spawn through a recording spawn seam, plus real
 * calls where they start nothing but git or pgrep. Nothing here starts a client.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childEnv, clientVersion, driverCodexHome, driverScratchHome, PGREP_ENV, processCount, realGit, type DriverSpawn } from "../../scripts/onboarding-eval-driver.js";
import { codexAuthPath, GIT_ENV } from "../../scripts/onboarding-eval-host.js";
import { checkoutState } from "../../scripts/onboarding-eval-run.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRET = "SECRET-VALUE-NEVER-PRINTED";
/** The driver's own environment as the operator would have it: the real home, a token, a Codex home, noise. */
const SOURCE: NodeJS.ProcessEnv = { PATH: "/opt/bin:/usr/bin:/bin", HOME: "/fake/real-home", CLAUDE_CODE_OAUTH_TOKEN: SECRET, CODEX_HOME: "/fake/real-home/.codex", GIT_DIR: "/elsewhere", LANG: "C" };

interface Call { readonly cmd: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly cwd?: string }
const recorder = (stdout: string, status = 0): { calls: Call[]; spawn: DriverSpawn } => {
  const calls: Call[] = [];
  return { calls, spawn: (cmd, args, o) => { calls.push({ cmd, args, env: { ...o.env }, ...("cwd" in o ? { cwd: (o as { cwd: string }).cwd } : {}) }); return { status, stdout }; } };
};

describe("S4 row b: the pgrep counts", () => {
  it("run pgrep with PGREP_ENV alone and count the lines", () => {
    const { calls, spawn } = recorder("101\n202\n");
    expect(processCount("vitest", spawn)).toBe(2);
    expect(calls).toEqual([{ cmd: "/usr/bin/pgrep", args: ["-f", "vitest"], env: { PATH: "/usr/bin:/bin" } }]);
    expect(PGREP_ENV).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("a real count runs and returns a number", () => {
    expect(processCount("t538-s4-no-such-process-pattern-xyz")).toBeGreaterThanOrEqual(0);
  });
});

describe("S4 row d: the clients' --version", () => {
  it.each(["claude", "codex"] as const)("%s --version gets the driver's PATH and the scratch HOME, nothing else", (arm) => {
    const { calls, spawn } = recorder(" 2.9.0 (Claude Code)\n");
    expect(clientVersion(arm, "/root/driver-home", SOURCE, spawn)).toBe("2.9.0 (Claude Code)");
    expect(calls).toEqual([{ cmd: arm, args: ["--version"], env: { PATH: "/opt/bin:/usr/bin:/bin", HOME: "/root/driver-home" } }]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(JSON.stringify(calls)).not.toContain("/fake/real-home");
  });

  it("a failed probe is null", () => {
    expect(clientVersion("codex", "/h", SOURCE, recorder("x", 1).spawn)).toBeNull();
  });
});

describe("S4 row g: the run and judge children", () => {
  it("get exactly PATH, the driver's scratch HOME and the Codex home: no token, no real HOME, nothing else", () => {
    const env = childEnv(SOURCE, "/root/driver-home", "/fake/real-home/.codex");
    expect(env).toEqual({ PATH: "/opt/bin:/usr/bin:/bin", HOME: "/root/driver-home", CODEX_HOME: "/fake/real-home/.codex" });
    expect(JSON.stringify(env)).not.toContain(SECRET);
  });

  it("the Codex home is the driver's CODEX_HOME, else the password-database home's; never HOME's", () => {
    let asked = 0;
    const home = (): string => { asked += 1; return "/pw/home"; };
    expect(driverCodexHome(SOURCE, home)).toBe("/fake/real-home/.codex");
    expect(asked).toBe(0);
    expect(driverCodexHome({ HOME: "/scratch/home" }, home)).toBe("/pw/home/.codex");
    expect(driverCodexHome({ HOME: "/scratch/home", CODEX_HOME: "" }, home)).toBe("/pw/home/.codex");
    expect(asked).toBe(2);
  });

  it("the driver's scratch home is made once under the experiment root, owner-only", () => {
    const root = mkdtempSync(join(tmpdir(), "s4-"));
    try {
      expect(driverScratchHome(root)).toBe(join(root, "driver-home"));
      expect(driverScratchHome(root)).toBe(join(root, "driver-home"));
      expect(statSync(join(root, "driver-home")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("the scratch home is validated without following anything (Codex S4 finding)", () => {
    const made: string[] = [];
    const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), "s4h-")); made.push(d); return d; };
    afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
    /** The version probe as the entry composes it: the home is computed before anything is spawned. */
    const probe = (root: string): Call[] => {
      const { calls, spawn } = recorder("1.0.0\n");
      expect(() => clientVersion("codex", driverScratchHome(root), SOURCE, spawn)).toThrow(/refused|does not exist/);
      return calls;
    };

    it("an existing driver-home symlink to another directory is refused, and nothing is spawned or changed there", () => {
      const root = fresh();
      const realHome = fresh();
      chmodSync(realHome, 0o755);
      symlinkSync(realHome, join(root, "driver-home"));
      expect(() => driverScratchHome(root)).toThrow(`the driver scratch home ${join(root, "driver-home")} is a symlink; refused`);
      expect(probe(root)).toEqual([]);
      expect(statSync(realHome).mode & 0o777).toBe(0o755);
      expect(lstatSync(join(root, "driver-home")).isSymbolicLink()).toBe(true);
    });

    it("a dangling driver-home symlink is refused, and its target is not created", () => {
      const root = fresh();
      const target = join(fresh(), "not-yet");
      symlinkSync(target, join(root, "driver-home"));
      expect(() => driverScratchHome(root)).toThrow("is a symlink; refused");
      expect(existsSync(target)).toBe(false);
    });

    it("a symlinked experiment root is refused, and nothing is made in its target", () => {
      const target = fresh();
      const root = join(fresh(), "root-link");
      symlinkSync(target, root);
      expect(() => driverScratchHome(root)).toThrow(`the experiment root ${root} is a symlink; refused`);
      expect(probe(root)).toEqual([]);
      expect(existsSync(join(target, "driver-home"))).toBe(false);
    });

    it("a regular file at driver-home is refused", () => {
      const root = fresh();
      writeFileSync(join(root, "driver-home"), "x");
      expect(() => driverScratchHome(root)).toThrow(`the driver scratch home ${join(root, "driver-home")} is not a directory; refused`);
      expect(probe(root)).toEqual([]);
    });

    it("a regular file as the experiment root is refused", () => {
      const root = join(fresh(), "file");
      writeFileSync(root, "x");
      expect(() => driverScratchHome(root)).toThrow(`the experiment root ${root} is not a directory; refused`);
    });

    it("a missing experiment root is refused and not created", () => {
      const root = join(fresh(), "missing");
      expect(() => driverScratchHome(root)).toThrow(`the experiment root ${root} does not exist`);
      expect(existsSync(root)).toBe(false);
    });

    it("an existing 0755 driver-home is tightened to 0700 and returned", () => {
      const root = fresh();
      mkdirSync(join(root, "driver-home"));
      chmodSync(join(root, "driver-home"), 0o755);
      expect(driverScratchHome(root)).toBe(join(root, "driver-home"));
      expect(statSync(join(root, "driver-home")).mode & 0o777).toBe(0o700);
    });

    it("a fresh create yields 0700, and a relative root resolves to the same home", () => {
      const root = fresh();
      expect(driverScratchHome(relative(process.cwd(), root))).toBe(join(root, "driver-home"));
      expect(statSync(join(root, "driver-home")).mode & 0o777).toBe(0o700);
    });

    it("a root or home owned by another uid is refused", () => {
      const root = fresh();
      const uid = process.getuid?.() ?? 0;
      vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(uid + 1);
      expect(() => driverScratchHome(root)).toThrow(`the experiment root ${root} is not owned by this user; refused`);
      expect(existsSync(join(root, "driver-home"))).toBe(false);
    });

    it("the real location is checked beneath the root (source pin: a non-symlink path cannot escape on this platform)", () => {
      const src = readFileSync(join(PKG, "scripts", "onboarding-eval-driver.ts"), "utf-8");
      expect(src).toContain('if (realpathSync(home) !== join(realpathSync(base), "driver-home")) throw new Error(');
    });
  });

  it("the Codex auth path needs an absolute CODEX_HOME; HOME is never a fallback", () => {
    expect(codexAuthPath({ CODEX_HOME: "/x/.codex", HOME: "/h" })).toBe("/x/.codex/auth.json");
    expect(codexAuthPath({ HOME: "/h" })).toBeNull();
    expect(codexAuthPath({ CODEX_HOME: "", HOME: "/h" })).toBeNull();
    expect(codexAuthPath({ CODEX_HOME: "rel/.codex", HOME: "/h" })).toBeNull();
  });

  it("the driver wires childEnv into the preflight and the executor, and the version probe into clientVersion", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-driver.ts"), "utf-8");
    expect(src).toContain("realPreflightProbe(PKG, git, root, childEnv(process.env, driverScratchHome(root), driverCodexHome(process.env)))");
    expect(src).toContain("executor: realExecutor({ pkg: PKG, node: process.execPath, env: childEnv(process.env, driverScratchHome(root), driverCodexHome(process.env)) }),");
    expect(src).toContain("const version = (a: Arm): string | null => clientVersion(a, driverScratchHome(root), process.env);");
    expect(src).toContain("counts: () => ({ vitest: processCount(\"vitest\"), jest: processCount(\"jest\") }),");
    expect(src).toContain("lstatSync(join(driverCodexHome(process.env), \"auth.json\"))");
  });

  it("no HOME fallback remains in the driver, the run or the judge", () => {
    for (const f of ["onboarding-eval-driver.ts", "onboarding-eval-run.ts", "onboarding-eval-judge.ts"]) {
      const src = readFileSync(join(PKG, "scripts", f), "utf-8");
      expect(src, f).not.toContain("homedir(");
      expect(src, f).not.toContain("process.env.HOME ??");
    }
    const run = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    expect(run).toContain("const realCodexAuth = codexAuthPath(process.env);\n  if (realCodexAuth === null) throw new Error(");
  });
});

describe("S4 row h: the run's identity git calls", () => {
  it("both run with GIT_ENV alone, in the package folder", () => {
    const calls: Call[] = [];
    const out = checkoutState((cmd, args, o) => { calls.push({ cmd, args, env: { ...o.env }, cwd: o.cwd }); return { status: 0, stdout: args[0] === "rev-parse" ? "abc\n" : " M scripts/x.ts\n" }; });
    expect(out).toEqual({ checkoutHead: "abc", checkoutDirty: "true" });
    expect(calls).toEqual([
      { cmd: "git", args: ["rev-parse", "HEAD"], env: { ...GIT_ENV }, cwd: PKG },
      { cmd: "git", args: ["status", "--porcelain", "--", "src", "scripts"], env: { ...GIT_ENV }, cwd: PKG },
    ]);
    expect(GIT_ENV).toEqual({ PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" });
  });

  it("a failed call reads unknown", () => {
    expect(checkoutState(() => ({ status: 128, stdout: "" }))).toEqual({ checkoutHead: "unknown", checkoutDirty: "unknown" });
  });

  describe("real calls ignore the process environment", () => {
    const saved = process.env.GIT_DIR;
    afterEach(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
    it("a GIT_DIR in the process environment does not reach the identity's git or the driver's git", () => {
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PKG, encoding: "utf-8", env: { ...GIT_ENV } }).stdout.trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      process.env.GIT_DIR = join(tmpdir(), "s4-no-such-git-dir");
      expect(checkoutState().checkoutHead).toBe(head);
      const g = realGit(PKG)(["rev-parse", "HEAD"]);
      expect(g.ok).toBe(true);
      expect(g.out.trim()).toBe(head);
    });
  });
});
