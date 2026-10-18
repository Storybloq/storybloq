import { afterEach, afterAll, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compareConfig, snapshotConfigAt, snapshotProductionConfig, type ConfigSnapshot } from "./helpers/git-config-tripwire.js";
import { clearIsolationViolation, recordedIsolationViolation } from "./helpers/git-fixture.js";
import { PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "../src/core/project-root-shared.js";

const CLIENT_IDENTITY_ENV = [
  "STORYBLOQ_CLIENT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;

function clearAmbientClientIdentity(): void {
  for (const key of CLIENT_IDENTITY_ENV) delete process.env[key];
}

/**
 * ISS-1220: strip git's repository-pointing variables from the WORKER'S OWN
 * environment, once per test file, exactly as the client-identity scrub above
 * does.
 *
 * `test/helpers/git-fixture.ts` scrubs the env it hands to each child, but it
 * only protects call sites that go through it. A survey found 75 direct
 * `execFileSync("git", ...)` calls in this suite that belong to no `git()`
 * helper (test/core/team-init, team-setup, reservation-check,
 * merge-driver-e2e's own setup, and others). Converting all of them would be a
 * large, risky diff across files this issue is not meant to touch; clearing
 * the variables at the source closes that escape route for every one of them,
 * for any spawn helper, and for any test added later.
 *
 * This covers the INHERITED-ENV route only. The upward-discovery route is
 * closed by the cwd assertion and GIT_CEILING_DIRECTORIES in the fixture
 * helper; those direct call sites already pass explicit temp fixture roots, so
 * discovery from them cannot climb into a real checkout.
 *
 * Cleared before each test rather than only once, so a test that sets one of
 * these deliberately cannot leak it into the next test. A test that needs one
 * sets it inside its own body, after this hook has run.
 */
const GIT_REPOSITORY_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
] as const;

function clearAmbientGitRepository(): void {
  for (const key of GIT_REPOSITORY_ENV) delete process.env[key];
}

/**
 * ISS-1305 (D9): a duet worker spawned in a directory with no ledger runs
 * with STORYBLOQ_PROJECT_ROOT set to the pen's board, and every process it
 * starts inherits it, this suite included. Discovery honours that variable
 * before any walk, so every discovering handler, and every built-CLI e2e
 * (whose env is this process's), would resolve the pen's REAL board from a
 * fixture and write real ledger files. Cleared at the source like the
 * variables above, before and after each test; a test that needs one sets it
 * in its own body.
 */
const PROJECT_ROOT_ENV = [PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR] as const;

function clearAmbientProjectRoot(): void {
  for (const key of PROJECT_ROOT_ENV) delete process.env[key];
}

// Test behavior must not depend on whether Vitest was launched by Claude Code,
// Codex, or a plain shell. Individual tests opt into client identity explicitly.
clearAmbientClientIdentity();
clearAmbientGitRepository();
clearAmbientProjectRoot();
// ISS-1270: storybloq resolves Claude's config dir from CLAUDE_CONFIG_DIR before
// HOME, so an inherited value would send every scratch-HOME test's writes to
// that directory. Cleared once per file, not per test: a test that sets it on
// purpose keeps it for its own duration.
delete process.env.CLAUDE_CONFIG_DIR;
beforeEach(clearAmbientClientIdentity);
afterEach(clearAmbientClientIdentity);
beforeEach(clearAmbientGitRepository);
afterEach(clearAmbientGitRepository);
beforeEach(clearAmbientProjectRoot);
afterEach(clearAmbientProjectRoot);

/**
 * ISS-1220: watch the real repository's git config for the duration of this
 * test file.
 *
 * The baseline is taken once per run by `e2e-acceptance-probe.global.ts` and
 * read from disk here. If that file is missing the baseline is computed
 * locally instead of skipping: a run that silently loses its tripwire is the
 * one case this must not allow, and one `git rev-parse` per worker is cheap.
 */
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CONFIG_SNAPSHOT_FILE = join(tmpdir(), "storybloq-iss1220-git-config-snapshot.json");

function baseline(): ConfigSnapshot | null {
  try {
    // Test-infra knob (same spirit as STORYBLOQ_E2E_PROBE_STRICT): lets this
    // wiring be proven by a child vitest run against a synthetic config,
    // instead of a test having to modify the real repository to prove the
    // afterAll fires. Never set in an ordinary run.
    const override = process.env.STORYBLOQ_ISS1220_CONFIG_PATH;
    if (override !== undefined && override !== "") return snapshotConfigAt(override);

    if (existsSync(CONFIG_SNAPSHOT_FILE)) {
      return JSON.parse(readFileSync(CONFIG_SNAPSHOT_FILE, "utf-8")) as ConfigSnapshot;
    }
    return snapshotProductionConfig(PKG_ROOT);
  } catch {
    // Not in a git repository (or git is unavailable): nothing to protect.
    return null;
  }
}

const configBaseline = baseline();

afterAll(() => {
  // A recorded isolation violation fails the file even when the throw itself
  // was swallowed by an `expect(...).toThrow()` that was written for an
  // ordinary git error. The guard must not be defeatable by a catch.
  const violation = recordedIsolationViolation();
  // Cleared immediately: a worker is reused across test files, and globalThis
  // outlives the module registry, so a violation left set would fail every
  // later file in that worker as a cascade and hide which file was at fault.
  clearIsolationViolation();
  if (violation !== undefined) {
    throw new Error(
      `ISS-1220: a fixture attempted to run git outside a temp root during this file.\n${violation}`,
    );
  }

  if (configBaseline === null) return;
  const failure = compareConfig(configBaseline, `test file: ${expandCurrentFile()}`);
  if (failure !== null) throw new Error(failure);
});

/** Best-effort name of the file being torn down, for the failure message. */
function expandCurrentFile(): string {
  return process.env.VITEST_WORKER_ID !== undefined
    ? `worker ${process.env.VITEST_WORKER_ID}`
    : "unknown";
}
