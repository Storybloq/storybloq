/**
 * ISS-1091 (F10): wires the audited-path acceptance probe into vitest's
 * `globalSetup`, which runs ONCE for the whole test run in a separate process
 * from any test file -- not per-fixture, not per-file. `globalSetup` can't
 * share JS module state with test files directly, so the before-snapshot is
 * persisted to a temp file and re-read by `teardown`.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { auditedPaths, snapshotAuditedPaths, diffAuditedPaths, classifyDiffs, type AuditedSnapshot } from "./helpers/e2e-acceptance-probe.js";
import { compareConfig, snapshotProductionConfig, type ConfigSnapshot } from "./helpers/git-config-tripwire.js";

const SNAPSHOT_FILE = join(tmpdir(), "storybloq-e2e-acceptance-probe-snapshot.json");

/** ISS-1220: the real repository's git config, snapshotted once for the whole run. */
const CONFIG_SNAPSHOT_FILE = join(tmpdir(), "storybloq-iss1220-git-config-snapshot.json");
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

export async function setup(): Promise<void> {
  const snapshot = snapshotAuditedPaths(auditedPaths());
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot), "utf-8");

  // ISS-1220: taken here so it costs one `git rev-parse` for the run rather
  // than one per test file; `test/setup.ts` reads it back and compares in an
  // afterAll, which bounds a violation to the file that caused it.
  try {
    const config = snapshotProductionConfig(PKG_ROOT);
    writeFileSync(CONFIG_SNAPSHOT_FILE, JSON.stringify(config), "utf-8");
  } catch {
    // Not a git repository, or git unavailable: setup.ts degrades on its own.
  }
}

/**
 * P1: STORYBLOQ_E2E_PROBE_STRICT=1 promotes WARN-ONLY diffs to hard failures.
 * This is test-infra probe configuration, not the R6-banned production
 * escape hatch (STORYBLOQ_TEST_MODE-shaped) -- it changes nothing about how
 * the CLI under test behaves, only how strictly THIS probe judges the
 * result. Used exclusively by the documented ship-time quiet-window
 * verification procedure in RELEASE.md, where even a live concurrent write
 * to the update-check cache/limit ledger must fail the check.
 */
export async function teardown(): Promise<void> {
  // ISS-1220: final backstop for anything written after the last afterAll.
  // Runs before the early return below so it is not skipped with it.
  let configFailure: string | null = null;
  if (existsSync(CONFIG_SNAPSHOT_FILE)) {
    const configBefore = JSON.parse(readFileSync(CONFIG_SNAPSHOT_FILE, "utf-8")) as ConfigSnapshot;
    unlinkSync(CONFIG_SNAPSHOT_FILE);
    configFailure = compareConfig(configBefore, "global teardown (after the last test file)");
  }
  if (configFailure !== null) throw new Error(configFailure);

  if (!existsSync(SNAPSHOT_FILE)) return; // setup never ran for this invocation -- nothing to compare
  const before = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as AuditedSnapshot;
  unlinkSync(SNAPSHOT_FILE);
  const paths = auditedPaths();
  const after = snapshotAuditedPaths(paths);
  const diffs = diffAuditedPaths(before, after);
  if (diffs.length === 0) return;

  const strict = process.env.STORYBLOQ_E2E_PROBE_STRICT === "1";
  const { hard: hardDiffs, warn: warnDiffs } = classifyDiffs(diffs, paths, strict);

  if (warnDiffs.length > 0) {
    const lines = warnDiffs.map((d) => `  - ${d.label}: ${d.before ?? "<absent>"} -> ${d.after ?? "<absent>"}`);
    process.stderr.write(
      "ISS-1091 e2e acceptance probe (WARN, not a failure): the update-check cache / limit ledger / waker " +
        "lock / limit retirement marker changed during this run. These are legitimately written by concurrent LIVE Claude Code " +
        "sessions/hooks on this machine (ISS-978's globally-symlinked storybloq binary), independent of this " +
        "suite's own isolation. Set STORYBLOQ_E2E_PROBE_STRICT=1 to promote this to a hard failure (used by " +
        "the ship-time quiet-window verification in RELEASE.md).\n" +
        lines.join("\n") +
        "\n",
    );
  }

  if (hardDiffs.length > 0) {
    const lines = hardDiffs.map((d) => `  - ${d.label}: ${d.before ?? "<absent>"} -> ${d.after ?? "<absent>"}`);
    throw new Error(
      "ISS-1091 e2e acceptance probe: real machine state changed under ~/.claude, ~/.agents, or the " +
        "effective CODEX_HOME during this test run. Every e2e CLI-subprocess test isolates HOME/CODEX_HOME/" +
        "STORYBLOQ_GLOBAL_DIR via test/helpers/e2e-cli.ts -- a change here means some call site is not " +
        "isolated (or a new subprocess-spawning test was added without going through the shared fixture). A " +
        "live version-skew refresh from a concurrent real CLI invocation on this machine is also possible " +
        "after commit 5 and a deploy-aligned build (rare) -- rule that out before assuming a test-isolation " +
        "gap.\n" +
        lines.join("\n"),
    );
  }
}
