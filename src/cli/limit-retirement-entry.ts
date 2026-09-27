/**
 * T-534: the CLI's single entry to the usage-limit retirement. Housekeeping,
 * `setup` and the `session limit-stop` tombstone call it. Once the marker
 * exists it costs one lstat; before that it runs Part A with Part B as its
 * session step. It never throws and never blocks the command it runs under.
 */
import { storybloqGlobalDir } from "../core/global-config.js";
import { defaultSettingsPath } from "../core/hook-migration.js";
import { discoverProjectRoot } from "../core/project-root-discovery.js";
import {
  DEFAULT_ATTEMPT_PROBES,
  DEFAULT_WAKER_STOP_DEPS,
  retirementMarkerPresent,
  runLimitRetirement,
  type RetirementResult,
} from "../core/limit-retirement.js";

export interface RetirementEntryOptions {
  /** "stderr" (default) reports an incomplete retirement once; "none" leaves reporting to the caller. */
  readonly report?: "stderr" | "none";
  readonly cwd?: string;
}

const LOCK_DEADLINE_MS = 250;

/**
 * The notes worth a user's attention: sessions the retirement skipped or could
 * not normalise (they are left untouched and refuse to resume until fixed).
 * Routine cleanup notes (hook rows removed, waker stopped) stay silent.
 */
export function sessionAttentionNotes(
  result: RetirementResult | { readonly kind: "error"; readonly message: string },
): readonly string[] {
  if (result.kind !== "retired" && result.kind !== "incomplete") return [];
  return result.notes.filter((n) => n.startsWith("session "));
}

export async function retireLimitAutoResumeBestEffort(
  version: string,
  opts: RetirementEntryOptions = {},
): Promise<RetirementResult | { readonly kind: "error"; readonly message: string }> {
  try {
    const globalDir = storybloqGlobalDir();
    if (retirementMarkerPresent(globalDir)) return { kind: "already" };
    const { normalizeRetiredParksBestEffort } = await import("../autonomous/retired-limit-park.js");
    const currentProject = discoverProjectRoot(opts.cwd);
    const result = await runLimitRetirement({
      globalDir,
      settingsPath: defaultSettingsPath(),
      cliVersion: version,
      probes: DEFAULT_ATTEMPT_PROBES,
      waker: DEFAULT_WAKER_STOP_DEPS,
      normalizeSessions: (sessions) => normalizeRetiredParksBestEffort(sessions, currentProject ?? null, { globalDir }),
      lockDeadlineMs: LOCK_DEADLINE_MS,
    });
    if (opts.report !== "none") {
      if (result.kind === "incomplete") {
        process.stderr.write(
          "storybloq: the usage-limit auto-resume retirement did not finish; it retries on the next command:\n" +
            result.problems.map((p) => `  - ${p}\n`).join(""),
        );
      }
      const attention = sessionAttentionNotes(result);
      if (attention.length > 0) {
        process.stderr.write(
          "storybloq: sessions stopped by the retired usage-limit auto-resume that were left untouched:\n" +
            attention.map((n) => `  - ${n}\n`).join(""),
        );
      }
    }
    return result;
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
