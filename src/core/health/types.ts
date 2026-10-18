/**
 * T-502: `storybloq health` -- the on-demand tooling check.
 *
 * Five checks answer one question each about the tooling AROUND the ledger:
 * an oversized auto-compact window, a stale CLI, a Codex install with no
 * review bridge, a stale `/story` skill, and a `crossSessionInbound` setting
 * that holds pen/worker messages instead of delivering them.
 *
 * Three rules hold for every check and are the reason this module exists as
 * its own layer rather than as six ad-hoc probes:
 *
 *  1. TWO ROOTS. `ledgerRoot` is the `.story/` root (null in degraded mode)
 *     and supplies CONFIG only. `projectDir` is the INVOCATION directory and
 *     supplies SETTINGS and MCP registrations. They are never interchanged:
 *     Claude Code resolves `.claude/settings*.json` and `.mcp.json` from the
 *     directory it was launched in, which for the CLI is `process.cwd()` and
 *     for the MCP server is the captured launch directory. A repository with
 *     no `.story/` still gets its project layers read, and the inspected
 *     directory is always reported so no message can be mistaken for a claim
 *     about the active Claude project.
 *
 *  2. READS ARE THREE-VALUED. Absent and unreadable are different answers. A
 *     layer that could not be read and COULD change the verdict makes the
 *     check `skip` naming the path; it never becomes a false `advise`. This is
 *     the whole reason the checks do not reuse the ordinary null-collapsing
 *     readers.
 *
 *  3. EVERY EFFECT IS INJECTED. `HealthDeps` is the only door to the file
 *     system, the environment, the clock, the platform and subprocesses, so
 *     the check modules are pure functions of their inputs and the default
 *     adapters (`deps.ts`) are the single place tested against a real but
 *     isolated HOME.
 *
 * The command never writes anything except the shared update-check cache, and
 * never throws: a check that fails reports `error` while the other four still
 * answer.
 */

import type { BundledBridge } from "../bridge-resolve.js";
import type { AutoCompactWindowDiagnostic } from "../claude-settings.js";
import type { SessionIntelConfig } from "../session-intel/config.js";
import type { SkillTargetInfo } from "../skill-version-marker.js";
import type { UpdateInfo } from "../update-check.js";

export const HEALTH_CHECK_IDS = [
  "usage-window",
  "cli-version",
  "codex-bridge",
  "skill-version",
  "cross-session-inbound",
  "hook-duplicates",
] as const;

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

/**
 * `skip` means "could not decide, and here is why": offline, Codex absent,
 * not applicable to this client, disabled by config, an unreadable source
 * that could change the verdict, or an exhausted time budget. `error` means
 * the check itself threw or rejected.
 */
export type HealthCheckStatus = "ok" | "advise" | "skip" | "error";

export interface HealthCheck {
  readonly id: HealthCheckId;
  readonly status: HealthCheckStatus;
  /** One sentence, plain words, always present. */
  readonly message: string;
  /**
   * The fix, present if and only if `status === "advise"`.
   *
   * For every advise the fix and the message are the SAME pinned text. The
   * observation and its remedy are written as one piece of prose (T-501's
   * `renderUsageAdvisory` already is), and splitting them would fork the
   * pinned wording into two strings that could drift. The skill relays this
   * field verbatim.
   */
  readonly advice: string | null;
  /** Machine facts: installed, latest, source, path, reason, scope, projectDir. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface HealthResult {
  readonly ranAt: string;
  readonly cliVersion: string;
  readonly client: HealthClient;
  /** The inspected invocation directory, reported on every run. */
  readonly projectDir: string;
  readonly checks: readonly HealthCheck[];
  readonly durationMs: number;
  readonly budgetExhausted: boolean;
}

export type HealthClient = "claude" | "codex";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** `.story/config.json` keys are camelCase; check ids are kebab-case. */
export const HEALTH_CONFIG_KEY: Readonly<Record<HealthCheckId, string>> = {
  "usage-window": "usageWindow",
  "cli-version": "cliVersion",
  "codex-bridge": "codexBridge",
  "skill-version": "skillVersion",
  "cross-session-inbound": "crossSessionInbound",
  "hook-duplicates": "hookDuplicates",
};

export interface HealthCheckConfig {
  readonly enabled: boolean;
  /** Per-check toggles, resolved to booleans (default true each). */
  readonly checks: Readonly<Record<HealthCheckId, boolean>>;
}

// ---------------------------------------------------------------------------
// Injected effects
// ---------------------------------------------------------------------------

/**
 * A read that distinguishes "there is nothing here" from "I could not tell".
 * `indeterminate` covers EACCES/EIO, a file over the cap, a non-regular file
 * (FIFO, socket, device) and anything else that left the content unknown.
 */
export type HealthRead =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

/**
 * A subprocess result that distinguishes a missing binary from one that did
 * not answer. The difference is user-visible: "Codex is not installed" and
 * "codex --version did not answer" are different sentences and only one of
 * them may be said when the probe timed out.
 */
export type HealthRun =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "enoent" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed"; readonly code: number | null };

/**
 * T-509: an MCP server launch exactly as registered. `argv` is
 * `[command, ...args]` with no re-tokenising; `envOverrides` is the
 * registration's own env map, merged over the inherited environment by the
 * default adapter (the check never reads `process.env`).
 */
export interface McpLaunch {
  readonly argv: readonly string[];
  readonly envOverrides: Readonly<Record<string, string>>;
}

/**
 * The outcome of one JSON-RPC `initialize` handshake over stdio. `ok` means
 * the server answered a well-formed initialize result; `not-attempted` means
 * the probe was never launched (budget exhausted), which the check must
 * report as "not probed", never as "broken".
 */
export type McpProbe =
  | { readonly kind: "ok"; readonly serverName: string; readonly serverVersion: string; readonly protocolVersion: string; readonly allocatedMs: number; readonly stderr: string }
  | { readonly kind: "enoent"; readonly allocatedMs: number }
  | { readonly kind: "timeout"; readonly allocatedMs: number }
  | { readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null; readonly stderr: string; readonly allocatedMs: number }
  | { readonly kind: "not-attempted"; readonly reason: string };

/** What the health check needs from T-501's read-only caller acquisition. */
export interface HealthCallerSample {
  readonly oneMillionFlag: boolean | null;
}

export type HealthMarkerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

export interface HealthDeps {
  readonly readFile: (path: string, maxBytes: number) => HealthRead;
  readonly run: (cmd: string, args: readonly string[], timeoutMs: number) => HealthRun;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /** ISS-1270: Claude Code's config dir (CLAUDE_CONFIG_DIR, else ~/.claude); the user settings layer lives here. */
  readonly claudeConfigDir: string;
  /** ISS-1270: the user-scope MCP registry, `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json`. */
  readonly claudeJsonPath: string;
  /** How the user settings file is named in a message, from the same resolution as claudeConfigDir. */
  readonly claudeSettingsDisplay: string;
  readonly platform: string;
  readonly settings: {
    readonly autoCompactWindow: (projectDir: string) => AutoCompactWindowDiagnostic;
  };
  /**
   * T-501's read-only acquisition, bounded by the remaining health budget.
   * Null whenever the caller's own session cannot be identified. It must
   * never consume the once-per-session usage stamp: that stamp belongs to
   * `storybloq_status`, and a health run is on demand and repeatable.
   */
  readonly callerSample: (budgetMs: number) => HealthCallerSample | null;
  readonly sessionIntelConfig: (ledgerRoot: string | null) => SessionIntelConfig;
  readonly versionCache: {
    readonly read: (currentVersion: string) => UpdateInfo | null;
    readonly refresh: (opts: {
      currentVersion: string;
      force: boolean;
      timeoutMs: number;
    }) => Promise<UpdateInfo | null>;
  };
  readonly skillMarker: {
    readonly targets: () => readonly SkillTargetInfo[];
    readonly installed: (target: SkillTargetInfo) => boolean;
    readonly marker: (target: SkillTargetInfo) => HealthMarkerRead;
  };
  readonly globalConfig: () => { healthCheck?: { enabled?: unknown } } | null;
  /** T-509: the optional bundled codex-claude-bridge, resolved without spawning. */
  readonly bundledBridge: () => BundledBridge;
  /** T-509: where `npm rebuild better-sqlite3` must run for the bridge at this executable; null when unknown. */
  readonly nativeRebuildDir: (executablePath: string) => string | null;
  /**
   * T-509: launch an MCP server and run the initialize handshake, bounded by
   * `capMs` and never past `deadlineAt`. The adapter owns the process tree:
   * whatever it started is gone when the promise settles.
   */
  readonly probeMcp: (launch: McpLaunch, deadlineAt: number, capMs: number) => Promise<McpProbe>;
}

export interface HealthContext {
  readonly ledgerRoot: string | null;
  readonly projectDir: string;
  readonly cliVersion: string;
  readonly client: HealthClient;
  readonly config: HealthCheckConfig;
  /** Absolute epoch-ms soft deadline for the WHOLE run. */
  readonly deadline: number;
}

export type HealthCheckFn = (ctx: HealthContext, deps: HealthDeps) => Promise<HealthCheck>;

// ---------------------------------------------------------------------------
// Small shared constructors
// ---------------------------------------------------------------------------

export function okCheck(
  id: HealthCheckId,
  message: string,
  detail: Record<string, string | number | boolean | null> = {},
): HealthCheck {
  return { id, status: "ok", message, advice: null, detail };
}

/** An advise always carries the SAME text as message and advice (see HealthCheck.advice). */
export function adviseCheck(
  id: HealthCheckId,
  text: string,
  detail: Record<string, string | number | boolean | null> = {},
): HealthCheck {
  return { id, status: "advise", message: text, advice: text, detail };
}

export function skipCheck(
  id: HealthCheckId,
  message: string,
  reason: string,
  detail: Record<string, string | number | boolean | null> = {},
): HealthCheck {
  return { id, status: "skip", message, advice: null, detail: { ...detail, reason } };
}

export function errorCheck(id: HealthCheckId, errorClass: string): HealthCheck {
  return {
    id,
    status: "error",
    message: `The ${id} check failed with ${errorClass}.`,
    advice: null,
    detail: { reason: errorClass },
  };
}

/**
 * A JSON object read on top of `deps.readFile`. `readFile` stays textual (the
 * skill marker is not JSON), so the "parses to a non-object is indeterminate"
 * rule lives here, in the one place every JSON layer goes through.
 */
export function readJsonObject(
  deps: Pick<HealthDeps, "readFile">,
  path: string,
  maxBytes: number,
):
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "indeterminate"; readonly reason: string } {
  const raw = deps.readFile(path, maxBytes);
  if (raw.kind !== "ok") return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { kind: "indeterminate", reason: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "indeterminate", reason: "not a JSON object" };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}
