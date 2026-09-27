/**
 * T-537: `checkpoint enable`, the one step that turns owner checkpoints on.
 * It stamps config schemaVersion 4, which older CLIs refuse and older Mac
 * builds open read-only, so nothing a pre-checkpoint build writes can drop a
 * checkpoint. Any project can enable: non-team and non-git ledgers are only
 * stamped. A team ledger merges through git, so there enable first proves
 * this clone merges checkpoints with the v4 driver, then writes the tracked
 * `-merge` block that makes every unconfigured clone conflict instead of
 * merging, and only then stamps. Each step is idempotent and the progress is
 * recorded in config, so an interrupted enable is finished by running it
 * again.
 */
import { execFile, execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { CliValidationError } from "../cli/helpers.js";
import { CHECKPOINT_SCHEMA_VERSION } from "./errors.js";
import { withProjectLock, writeConfigUnlocked } from "./project-loader.js";
import {
  MERGE_DRIVER_V4_CMD,
  MERGE_DRIVER_V4_NAME,
  effectiveMergeDriver,
  writeCheckpointGitattributes,
} from "./team-setup.js";

const execFileAsync = promisify(execFile);

/** The ledger paths whose effective driver proves a clone's setup: a ticket, an issue and the config. */
export const CHECKPOINT_PROBE_PATHS = ["tickets/t-checkpointprobe.json", "issues/i-checkpointprobe.json", "config.json"] as const;

/** Where an enable stands, recorded in config under `checkpointEnable`. */
export type CheckpointEnableStep = "attributes" | "complete";

export interface CheckpointEnableResult {
  readonly status: "enabled" | "already";
  /** Whether the team path ran (validation, tracked block) or only the stamp. */
  readonly team: boolean;
}

/** What enable asks of the world, injectable so the refusal paths are testable without a real binary. */
export interface CheckpointEnableDeps {
  /** The JSON `storybloq merge-driver --protocol 4 --capabilities` prints for the binary git would run, or null. */
  capabilities(gitRoot: string): Promise<unknown>;
  /** Test seam: runs after the unlocked decision and before the final lock that re-checks it. */
  afterDecision?(root: string): Promise<void>;
}

export const defaultEnableDeps: CheckpointEnableDeps = {
  async capabilities(gitRoot) {
    try {
      const { stdout } = await execFileAsync("storybloq", ["merge-driver", "--protocol", "4", "--capabilities"], { cwd: gitRoot, timeout: 10_000 });
      return JSON.parse(stdout.trim()) as unknown;
    } catch {
      return null;
    }
  },
};

/**
 * The repository `root` sits in, or null only when git itself answers that
 * it is not in one. A git that cannot run, times out or is refused access
 * leaves that unknown, and a team ledger in a repository must not be stamped
 * without its merge setup, so enable refuses and writes nothing.
 */
function gitRootOf(root: string): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, env: { ...process.env, LC_ALL: "C" },
    }).trim();
    if (top) return top;
    throw new Error("git printed no repository root");
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; code?: string; stderr?: unknown; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    if (e.status === 128 && /not a git repository/i.test(stderr)) return null;
    const why = e.code === "ENOENT" ? "git is not on PATH"
      : e.code === "ETIMEDOUT" ? "git timed out"
      : e.signal ? `git was stopped by ${e.signal}`
      : typeof e.status === "number" ? `git exited ${e.status}: ${stderr.trim().split("\n")[0] || "no message"}`
      : (e.message ?? String(err));
    throw new CliValidationError(
      "io_error",
      `Cannot enable owner checkpoints: this is a team ledger and git could not tell whether it is in a repository (${why}). ` +
        "A team ledger in a repository needs its merge setup checked before the stamp, so nothing was written. Make git runnable here, then enable again.",
    );
  }
}

/**
 * The driver git resolves for each probe path of the ledger at `storyDir`, in
 * CHECKPOINT_PROBE_PATHS order; null where it is unset or unknowable. Shared
 * by enable and `team doctor`.
 */
export function checkpointMergeDrivers(storyDir: string): { path: string; driver: string | null }[] {
  const root = dirname(storyDir);
  return CHECKPOINT_PROBE_PATHS.map((p) => {
    const path = `${basename(storyDir)}/${p}`;
    return { path, driver: effectiveMergeDriver(root, path) };
  });
}

/** Every reason this clone cannot merge checkpoints yet; empty when it can. Reads only. */
export async function checkpointMergeProblems(root: string, gitRoot: string, deps: CheckpointEnableDeps): Promise<string[]> {
  const problems: string[] = [];
  let registered: string | null = null;
  try {
    registered = execFileSync("git", ["config", "--local", "--get", `merge.${MERGE_DRIVER_V4_NAME}.driver`], { cwd: gitRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    registered = null;
  }
  if (registered !== MERGE_DRIVER_V4_CMD) {
    problems.push(registered === null
      ? `the ${MERGE_DRIVER_V4_NAME} merge driver is not registered in this clone`
      : `the ${MERGE_DRIVER_V4_NAME} merge driver runs "${registered}", expected "${MERGE_DRIVER_V4_CMD}"`);
  }
  const caps = await deps.capabilities(gitRoot);
  const protocol = typeof caps === "object" && caps !== null ? (caps as Record<string, unknown>).protocol : undefined;
  const maxSchema = typeof caps === "object" && caps !== null ? (caps as Record<string, unknown>).maxSchemaVersion : undefined;
  if (protocol !== 4 || typeof maxSchema !== "number" || maxSchema < CHECKPOINT_SCHEMA_VERSION) {
    problems.push("the storybloq binary git would run does not answer `merge-driver --protocol 4 --capabilities` (it predates owner checkpoints, or is not on PATH)");
  }
  for (const { path, driver } of checkpointMergeDrivers(join(root, ".story"))) {
    if (driver !== MERGE_DRIVER_V4_NAME) problems.push(`git merges ${path} with ${driver ?? "no driver"}, not ${MERGE_DRIVER_V4_NAME}`);
  }
  return problems;
}

function stepRecord(step: CheckpointEnableStep): { step: CheckpointEnableStep; at: string } {
  return { step, at: new Date().toISOString() };
}

/** How many times enable re-decides when the config's team mode changed under it. */
const DECISION_ATTEMPTS = 3;

export async function enableCheckpoints(root: string, deps: CheckpointEnableDeps = defaultEnableDeps): Promise<CheckpointEnableResult> {
  for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt++) {
    let teamEnabled = false;
    await withProjectLock(root, { strict: false }, async ({ state }) => {
      teamEnabled = state.config.team?.enabled === true;
    });
    const gitRoot = teamEnabled ? gitRootOf(root) : null;
    const team = teamEnabled && gitRoot !== null;
    // Validation runs a subprocess, so it runs outside the lock; the lock
    // below re-reads the one input it decided on and starts over if it moved.
    const problems = team ? await checkpointMergeProblems(root, gitRoot!, deps) : [];
    await deps.afterDecision?.(root);

    let result: CheckpointEnableResult | "moved" = "moved";
    await withProjectLock(root, { strict: false }, async ({ state }) => {
      if ((state.config.team?.enabled === true) !== teamEnabled) return;
      const done = state.config.schemaVersion !== undefined && state.config.schemaVersion >= CHECKPOINT_SCHEMA_VERSION
        && state.config.checkpointEnable?.step === "complete";
      if (!team) {
        if (done) { result = { status: "already", team }; return; }
        await writeConfigUnlocked({ ...state.config, schemaVersion: CHECKPOINT_SCHEMA_VERSION, checkpointEnable: stepRecord("complete") }, root);
        result = { status: "enabled", team };
        return;
      }
      if (problems.length > 0) {
        throw new CliValidationError(
          "conflict",
          `Cannot enable owner checkpoints: this clone cannot merge them yet. ${problems.map((p) => `- ${p}`).join(" ")} ` +
            "Run `storybloq team setup` (with a storybloq that supports owner checkpoints on PATH), then `storybloq team doctor`, then enable again. Nothing was written.",
        );
      }
      if (done) {
        // A completed enable still repairs a tracked block someone removed or reordered.
        writeCheckpointGitattributes(join(root, ".story"));
        result = { status: "already", team };
        return;
      }
      const attributes = { ...state.config, checkpointEnable: stepRecord("attributes") };
      await writeConfigUnlocked(attributes, root);
      writeCheckpointGitattributes(join(root, ".story"));
      await writeConfigUnlocked({ ...attributes, schemaVersion: CHECKPOINT_SCHEMA_VERSION, checkpointEnable: stepRecord("complete") }, root);
      result = { status: "enabled", team };
    });
    if (result !== "moved") return result;
  }
  throw new CliValidationError("conflict", "Cannot enable owner checkpoints: the project's team mode kept changing while enable ran. Nothing was written; run it again.");
}
