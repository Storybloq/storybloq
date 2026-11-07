/**
 * ISS-1220, half 2: the backstop for half 1.
 *
 * The cwd guard and the env scrub prevent a fixture from reaching the real
 * repository. This watches the real `.git/config` and fails the run if
 * something got through anyway -- a call site that bypasses the helper, a
 * subprocess spawned by the CLI under test, or a mechanism nobody has thought
 * of yet. The 2026-09-14 incident's own cause is still unproven, which is
 * exactly why a prevention-only fix is not enough.
 *
 * Same shape as the audited-path probe in `e2e-acceptance-probe.global.ts`:
 * snapshot before, compare after, report a diff.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

/** ISS-1420: names this run's own snapshot directory, set by the global setup for its workers. */
export const PROBE_DIR_ENV = "STORYBLOQ_E2E_PROBE_DIR";
export const CONFIG_SNAPSHOT_BASENAME = "git-config-snapshot.json";

export interface ConfigSnapshot {
  /** Absolute path to the watched config file. */
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

/**
 * Absolute path to the real repository's shared config file.
 *
 * `git rev-parse --git-common-dir` alone returns the RELATIVE string ".git"
 * from a main worktree, which would then be resolved against whatever cwd the
 * reading process happened to have -- silently watching the wrong file, or
 * none. `--path-format=absolute` (git >= 2.31) fixes that at the source;
 * the resolve() fallback covers older git, and the result is asserted
 * absolute before use.
 */
export function resolveGitCommonDir(fromDir: string): string {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: fromDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: fromDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  const abs = isAbsolute(out) ? out : resolve(fromDir, out);
  /* c8 ignore next */
  if (!isAbsolute(abs)) throw new Error(`ISS-1220: could not resolve an absolute git common dir from ${fromDir}`);
  return abs;
}

export function snapshotConfigAt(path: string): ConfigSnapshot {
  const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
  return { path, sha256: createHash("sha256").update(text).digest("hex"), text };
}

export function snapshotProductionConfig(fromDir: string): ConfigSnapshot {
  return snapshotConfigAt(join(resolveGitCommonDir(fromDir), "config"));
}

/** Minimal line diff -- enough to see what a fixture wrote, without a dependency. */
function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const removed = a.filter((l) => !b.includes(l)).map((l) => `  - ${l}`);
  const added = b.filter((l) => !a.includes(l)).map((l) => `  + ${l}`);
  return [...removed, ...added].join("\n") || "  (whitespace-only or reordered change)";
}

/**
 * Returns null when the config is unchanged, or the failure message when it is
 * not. Returning rather than throwing keeps this callable from both the
 * per-file `afterAll` and the global teardown.
 */
export function compareConfig(before: ConfigSnapshot, context: string): string | null {
  const after = snapshotConfigAt(before.path);
  if (after.sha256 === before.sha256) return null;
  return (
    `ISS-1220: the real repository's git config changed during the test run.\n` +
    `  file:    ${before.path}\n` +
    `  before:  ${before.sha256}\n` +
    `  after:   ${after.sha256}\n` +
    `  context: ${context}\n` +
    lineDiff(before.text, after.text) +
    `\n\nA test fixture reached the real repository. This is the 2026-09-14 incident shape ` +
    `(the checkout went bare with the t@t.t identity). Every fixture git call must go through ` +
    `test/helpers/git-fixture.ts, which scrubs GIT_DIR and friends and refuses a cwd outside ` +
    `os.tmpdir().\n` +
    `Rule this out first: a concurrent LIVE write to this checkout by a real process -- ` +
    `\`git worktree add\` flips extensions.worktreeConfig, and a developer or agent running ` +
    `\`git config\` mid-run would look identical. Check the diff above before assuming a test gap.`
  );
}
