/**
 * Pre-command housekeeping: silent operations that run on every CLI
 * invocation before the user's command dispatches. Extracted from
 * cli/index.ts so the real startup path can be exercised by tests
 * without triggering the top-level `runCli()` side effect.
 *
 * Currently:
 *   - ISS-570 G3: auto-refresh /story skill files when the CLI version
 *     differs from the skill-dir marker.
 *   - ISS-590: legacy hook sweep runs inside autoRefreshSkillIfStale
 *     when the marker advances.
 *   - ISS-570 G1: kick off a background npm-registry check so the
 *     next invocation has fresh update-available data.
 *
 * Best-effort: never blocks the user's command and never throws.
 */

import { Parser } from "yargs/helpers";

/**
 * ISS-777: pure predicate for the CLI entry point deciding when to SKIP
 * preCommandHousekeeping (an awaited skill refresh + a background npm-registry
 * fetch). These entry points run programmatically, many times, and must never
 * phone the npm registry per invocation:
 *   - merge-driver: git spawns it once per merged .story file (ISS-736).
 *   - hook-status: the Claude Code Stop hook, fires on every response.
 *   - hook-bus-tool: the PostToolUse (on-tool) Bus hook, fires on every tool call.
 *   - session compact-prepare / resume-prompt: the PreCompact + SessionStart
 *     hooks (see core/hook-migration.ts).
 * Interactive `session` subcommands (list/show/stop/...) keep housekeeping.
 *
 * `argv` is the hideBin(process.argv) slice, so argv[0] is the command name.
 * Kept dependency-free (no heavy imports) because index.ts runs it on every
 * CLI start.
 */
/**
 * T-502: the command and subcommand are resolved with YARGS' OWN PARSER, not
 * by reading argv[0] and argv[1].
 *
 * yargs accepts options before and between positionals, so `--format=json
 * health`, `--refresh false health` and `session --format=json intel-start`
 * are all valid invocations whose positionals are not where a naive index
 * lookup expects them. Getting this wrong is not cosmetic: it silently ran a
 * skill refresh, a hook reconcile and a background registry fetch before the
 * UserPromptSubmit hook that sits on the user's critical path, and before the
 * one command whose entire job is to REPORT on that tooling rather than
 * quietly repair it.
 *
 * Hand-rolling the option semantics was the first attempt and it was wrong
 * twice over (an explicit boolean value, and options between a command and
 * its subcommand), so the parser yargs itself uses decides instead. `Parser`
 * is a public export of `yargs/helpers`, a direct dependency; the boolean
 * list is what stops a following positional from being eaten as a flag value,
 * and `format` is declared a string for the same reason in reverse.
 */
const PARSER_BOOLEANS = ["refresh", "raw", "help", "version", "force", "yes", "all"];
const PARSER_STRINGS = ["format"];

export function commandTokensFrom(argv: string[]): { command?: string; subcommand?: string } {
  try {
    const positional = Parser(argv, { boolean: [...PARSER_BOOLEANS], string: [...PARSER_STRINGS] })._;
    return {
      ...(positional[0] !== undefined ? { command: String(positional[0]) } : {}),
      ...(positional[1] !== undefined ? { subcommand: String(positional[1]) } : {}),
    };
  } catch {
    // Never let a parse failure decide housekeeping: fall back to the plain
    // reading, which is what this predicate did before.
    return { ...(argv[0] !== undefined ? { command: argv[0] } : {}), ...(argv[1] !== undefined ? { subcommand: argv[1] } : {}) };
  }
}

export function shouldSkipHousekeeping(argv: string[]): boolean {
  const { command, subcommand } = commandTokensFrom(argv);
  if (command === "merge-driver") return true;
  if (command === "hook-status") return true;
  // T-427: the PostToolUse (on-tool) Bus hook fires after every tool call and must
  // start instantly and never phone the npm registry.
  if (command === "hook-bus-tool") return true;
  // T-424: waker-run is the detached background waker; limit-stop is the
  // StopFailure hook. Both must start instantly and never phone the registry.
  if (command === "waker-run") return true;
  // T-502: `storybloq health` REPORTS on the tooling, so nothing may change it
  // first. A skill refresh, a hook reconcile, a telemetry sweep, a waker spawn
  // or a background registry fetch running before the checks would let the
  // command silently repair what it was asked to describe, and the user would
  // be told everything was fine.
  if (command === "health") return true;
  if (
    command === "session" &&
    (subcommand === "compact-prepare" || subcommand === "resume-prompt" || subcommand === "limit-stop" ||
      // T-499: the SessionStart capture and the synchronous UserPromptSubmit
      // sample fire on every session start and every prompt; the prompt hook
      // in particular sits on the user's critical path.
      subcommand === "intel-start" || subcommand === "intel-prompt")
  ) {
    return true;
  }
  return false;
}

export async function preCommandHousekeeping(version: string, argv: string[] = []): Promise<void> {
  if (!version || version === "0.0.0-dev") return;
  // A setup invocation carrying --skip-hooks is an explicit opt-out: BOTH the
  // version-refresh reconcile (inside autoRefreshSkillIfStale) and the direct
  // reconcile below must honor it. This flag is computed FIRST so the refresh
  // call can suppress its limit-hook reconcile too (otherwise --skip-hooks was
  // defeated by the refresh installing hooks before setup ran).
  const isSetupSkippingHooks =
    (argv[0] === "setup" || argv[0] === "setup-skill") && argv.includes("--skip-hooks");
  try {
    const { autoRefreshSkillIfStale } = await import("../core/skill-version-marker.js");
    await autoRefreshSkillIfStale(version, { reconcileLimitHooks: !isSetupSkippingHooks });
  } catch {
    // Best-effort; never block the user's command.
  }
  if (!isSetupSkippingHooks) {
    try {
      // T-499: self-healing session-intel hook reconcile (cheap settings.json check).
      const { ensureSessionIntelHooksRegistered } = await import("./commands/setup-skill.js");
      await ensureSessionIntelHooksRegistered();
    } catch {
      // Best-effort.
    }
  }
  try {
    // T-499: the session-intel telemetry sweep (era store, orphan pending
    // directories). Housekeeping is its ONLY entry point; it is never run from
    // a hook or a sampler. Bounded: 25 era entries under a 1 s budget.
    const { discoverProjectRoot } = await import("../core/project-root-discovery.js");
    const root = discoverProjectRoot();
    if (root) {
      const { sweepSessionIntelTelemetry } = await import("../core/session-intel/housekeeping.js");
      sweepSessionIntelTelemetry(root);
    }
  } catch {
    // Best-effort.
  }
  if (!isSetupSkippingHooks) {
    try {
      // T-534: retire the usage-limit auto-resume (hooks, waker, global
      // artifacts). One lstat once the marker exists; never blocks the command.
      // `setup --skip-hooks` leaves settings.json alone; the next command retires.
      const { retireLimitAutoResumeBestEffort } = await import("./limit-retirement-entry.js");
      await retireLimitAutoResumeBestEffort(version);
    } catch {
      // Best-effort.
    }
  }
  try {
    const { refreshUpdateCacheInBackground } = await import("../core/update-check.js");
    refreshUpdateCacheInBackground();
  } catch {
    // Best-effort.
  }
}
