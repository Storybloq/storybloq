/**
 * T-502 test seam: a HealthDeps built from plain data.
 *
 * Every check is a pure function of these, so a fixture is a file map plus a
 * handful of stubs -- no network, no spawn, no writable HOME. The default
 * adapters get their own test (deps.test.ts) against a real isolated HOME,
 * which is the only place the syscalls are exercised.
 */

import { vi } from "vitest";
import type { BundledBridge } from "../../../src/core/bridge-resolve.js";
import { resolveSessionIntelConfig } from "../../../src/core/session-intel/config.js";
import type { SkillTargetInfo } from "../../../src/core/skill-version-marker.js";
import type {
  HealthCheckConfig,
  HealthContext,
  HealthDeps,
  HealthMarkerRead,
  HealthRead,
  HealthRun,
  McpLaunch,
  McpProbe,
} from "../../../src/core/health/types.js";
import { HEALTH_CHECK_IDS } from "../../../src/core/health/types.js";

export const HOME = "/home/tester";
export const PROJECT = "/repo/app";

/** A file map: string content, or an explicit three-valued reading. */
export type FileMap = Record<string, string | HealthRead>;

export interface StubOptions {
  files?: FileMap;
  readFile?: HealthDeps["readFile"];
  run?: (cmd: string, args: readonly string[], timeoutMs: number) => HealthRun;
  now?: () => number;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  claudeConfigDir?: string;
  claudeJsonPath?: string;
  claudeSettingsDisplay?: string;
  platform?: string;
  settings?: HealthDeps["settings"];
  callerSample?: HealthDeps["callerSample"];
  sessionIntel?: Record<string, unknown> | null;
  versionCache?: Partial<HealthDeps["versionCache"]>;
  skillMarker?: Partial<HealthDeps["skillMarker"]>;
  globalConfig?: HealthDeps["globalConfig"];
  bundledBridge?: BundledBridge;
  nativeRebuildDir?: HealthDeps["nativeRebuildDir"];
  probeMcp?: HealthDeps["probeMcp"];
}

export function stubDeps(opts: StubOptions = {}): HealthDeps {
  const files = opts.files ?? {};
  return {
    readFile: opts.readFile ?? ((path) => {
      const entry = files[path];
      if (entry === undefined) return { kind: "absent" };
      return typeof entry === "string" ? { kind: "ok", text: entry } : entry;
    }),
    run: opts.run ?? (() => ({ kind: "enoent" })),
    now: opts.now ?? (() => 1_000),
    env: opts.env ?? {},
    homeDir: opts.homeDir ?? HOME,
    claudeConfigDir: opts.claudeConfigDir ?? `${opts.homeDir ?? HOME}/.claude`,
    claudeJsonPath: opts.claudeJsonPath ?? `${opts.homeDir ?? HOME}/.claude.json`,
    claudeSettingsDisplay: opts.claudeSettingsDisplay ?? "~/.claude/settings.json",
    platform: opts.platform ?? "darwin",
    settings: opts.settings ?? { autoCompactWindow: () => ({ layers: [] }) },
    callerSample: opts.callerSample ?? (() => null),
    sessionIntelConfig: () => resolveSessionIntelConfig(opts.sessionIntel ?? null),
    versionCache: {
      read: opts.versionCache?.read ?? (() => null),
      refresh: opts.versionCache?.refresh ?? (async () => null),
    },
    skillMarker: {
      targets: opts.skillMarker?.targets ?? (() => []),
      installed: opts.skillMarker?.installed ?? (() => false),
      marker: opts.skillMarker?.marker ?? ((): HealthMarkerRead => ({ kind: "absent" })),
    },
    globalConfig: opts.globalConfig ?? (() => null),
    bundledBridge: () => opts.bundledBridge ?? { kind: "absent" },
    nativeRebuildDir: opts.nativeRebuildDir ?? (() => null),
    probeMcp: opts.probeMcp ?? (async () => ({ kind: "not-attempted", reason: "stub" })),
  };
}

export function allChecksOn(): HealthCheckConfig {
  const checks = {} as Record<(typeof HEALTH_CHECK_IDS)[number], boolean>;
  for (const id of HEALTH_CHECK_IDS) checks[id] = true;
  return { enabled: true, checks };
}

export function ctxFor(over: Partial<HealthContext> = {}): HealthContext {
  return {
    ledgerRoot: "/repo",
    projectDir: PROJECT,
    cliVersion: "1.14.0",
    client: "claude",
    config: allChecksOn(),
    deadline: 6_000,
    ...over,
  };
}

export function skillTarget(over: Partial<SkillTargetInfo> = {}): SkillTargetInfo {
  return {
    id: "claude",
    client: "claude",
    dir: `${HOME}/.claude/skills/story`,
    displayPath: "~/.claude/skills/story/",
    ...over,
  };
}

/** A probe stub that records every launch it was handed and answers per call, last answer repeating. */
export function probeStub(...answers: McpProbe[]) {
  let i = 0;
  return vi.fn(async (_launch: McpLaunch, _deadlineAt: number, _capMs: number): Promise<McpProbe> => {
    const a = answers[Math.min(i, answers.length - 1)] ?? { kind: "not-attempted", reason: "stub" };
    i += 1;
    return a;
  });
}

export const PROBE_OK: McpProbe = { kind: "ok", serverName: "codex-claude-bridge", serverVersion: "1.8.0", protocolVersion: "2024-11-05", allocatedMs: 5000, stderr: "" };

/** A spawn stub that records how it was called. */
export function runStub(result: HealthRun) {
  return vi.fn((_cmd: string, _args: readonly string[], _timeoutMs: number) => result);
}
