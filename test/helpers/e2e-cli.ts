/**
 * ISS-1091: shared isolation for every test that spawns a real `dist/cli.js`
 * subprocess. Before this helper, each e2e file rolled its own (inconsistent)
 * HOME override or none at all, so those subprocesses could read/write the
 * real developer machine's `~/.claude/skills`, Codex config/hooks, the
 * update-check cache, and the limit ledger -- and, on a machine where a
 * concurrent process invokes a different CLI version, race the skill-marker
 * refresh and leak a stderr notice into a test's captured output.
 *
 * `E2ECliFixture` owns a per-fixture scratch HOME/CODEX_HOME/
 * STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME and exposes `env()` for call sites with
 * their own spawn/stdin/signal/timeout semantics (MCP long-lived subprocess,
 * readiness polling, deliberately-open stdin, concurrent children). `runE2ECli`
 * is a convenience wrapper over the fixture for the simple
 * spawn-wait-inspect-output case.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
export const CLI_PATH = join(pkgRoot, "dist", "cli.js");

const PROTECTED_ENV_VARS = ["HOME", "USERPROFILE", "CODEX_HOME", "STORYBLOQ_GLOBAL_DIR", "XDG_CONFIG_HOME"] as const;

export interface E2ECapturedResult {
  stdout: string;
  stderr: string;
}

/** The three housekeeping side-effect notices `preCommandHousekeeping` can print to stderr (F6). */
const NOTICE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "skill refresh", pattern: /refreshed skill files/ },
  { label: "codex mcp config refresh", pattern: /refreshed Codex Storybloq MCP config/ },
  { label: "codex hook refresh", pattern: /refreshed .*Codex hook entr/ },
];

export class E2ECliFixture {
  private readonly results: E2ECapturedResult[] = [];

  private constructor(
    readonly root: string,
    readonly home: string,
    readonly codexHome: string,
    readonly globalDir: string,
    readonly xdgConfigHome: string,
  ) {}

  static async create(): Promise<E2ECliFixture> {
    const root = await mkdtemp(join(tmpdir(), "storybloq-e2e-"));
    const home = join(root, "home");
    const codexHome = join(root, "codex-home");
    const globalDir = join(root, "global-dir");
    const xdgConfigHome = join(root, "xdg-config-home");
    // "Genuinely empty" means an EXISTING empty dir (P2) -- a nonexistent HOME
    // produces inconsistent behavior for code that expands ~ or writes without
    // mkdir -p, and would push mkdir-before-use onto every seeding call site.
    await Promise.all([mkdir(home, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(globalDir, { recursive: true }), mkdir(xdgConfigHome, { recursive: true })]);
    return new E2ECliFixture(root, home, codexHome, globalDir, xdgConfigHome);
  }

  /**
   * Builds the env object for a subprocess. HOME/USERPROFILE/CODEX_HOME/
   * STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME are always the fixture's own scratch
   * paths -- `overrides` cannot widen the isolation boundary (F12: rejects any
   * attempt unconditionally, not just ones that resolve outside the fixture).
   */
  env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    for (const key of PROTECTED_ENV_VARS) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        throw new Error(
          `E2ECliFixture.env(): overriding ${key} is not permitted -- it is isolation-critical. ` +
            "Read it off the fixture instance instead (fixture.home / fixture.codexHome / " +
            "fixture.globalDir / fixture.xdgConfigHome).",
        );
      }
    }
    return {
      ...process.env,
      ...overrides,
      HOME: this.home,
      USERPROFILE: this.home,
      CODEX_HOME: this.codexHome,
      STORYBLOQ_GLOBAL_DIR: this.globalDir,
      XDG_CONFIG_HOME: this.xdgConfigHome,
      STORYBLOQ_DISABLE_WAKER_SPAWN: "1",
    };
  }

  /** Registers a captured child result with the F6 notice-pattern registry. */
  recordResult(result: E2ECapturedResult): void {
    this.results.push(result);
  }

  /** Alias for recordResult (F8) -- call sites that already say "trackChild" in their own vocabulary use this name. */
  trackChild(result: E2ECapturedResult): void {
    this.recordResult(result);
  }

  /** F6: fails loudly if any recorded child emitted a housekeeping side-effect notice. */
  assertNoHousekeepingNotices(): void {
    for (const result of this.results) {
      const combined = `${result.stdout}\n${result.stderr}`;
      for (const { label, pattern } of NOTICE_PATTERNS) {
        if (pattern.test(combined)) {
          throw new Error(
            `E2ECliFixture: a recorded child emitted a ${label} notice. Housekeeping should never run ` +
              "against this fixture's isolated HOME/CODEX_HOME -- either the fixture's isolation has a " +
              "gap, or this call site isn't actually using fixture.env().\n" +
              `Matched output:\n${combined}`,
          );
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export interface RunE2ECliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunE2ECliOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Convenience wrapper for the simple "spawn, wait for exit, inspect output"
 * case. Long-lived (MCP subprocess), readiness-polling, stdin-driven, or
 * signal-driven call sites keep their own spawn call and use `fixture.env()`
 * directly instead -- see the plan's Design section for why a single wrapper
 * can't serve every call site.
 */
export function runE2ECli(fixture: E2ECliFixture, args: string[], opts: RunE2ECliOptions = {}): RunE2ECliResult {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd,
    encoding: "utf-8",
    input: opts.input,
    // Every migrated call site's original helper explicitly ignored stdin
    // (`stdio: ["ignore", "pipe", "pipe"]`) to avoid a child blocking on an
    // open, never-closed stdin pipe. Verified directly (not assumed): explicit
    // stdio[0]="ignore" SUPPRESSES `input` entirely rather than being
    // overridden by it, so this must only apply when no input is given --
    // otherwise a caller's `opts.input` would silently reach the child as
    // nothing.
    stdio: opts.input === undefined ? ["ignore", "pipe", "pipe"] : undefined,
    env: fixture.env(opts.env),
    timeout: opts.timeout ?? 30_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  fixture.recordResult({ stdout, stderr });
  // P4: spawnSync's `error` (ENOENT, timeout, ...) must surface loudly rather
  // than silently degrading to a null status with empty output -- otherwise
  // the failure shows up as a confusing downstream assertion mismatch instead
  // of the actual spawn error. Recorded first so partial output still reaches
  // the F6 notice registry even when the child never really ran.
  if (result.error) throw result.error;
  return { status: result.status, stdout, stderr };
}

/** Parses the stdout-only JSON envelope (fix direction d) -- stderr is never mixed into the parse. */
export function parseE2EJson<T = unknown>(result: RunE2ECliResult): T {
  return JSON.parse(result.stdout) as T;
}
