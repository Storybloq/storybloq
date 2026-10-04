import { createRequire } from "node:module";
import type { Config } from "../models/config.js";
import { ProjectLoaderError } from "./errors.js";

// Canonical team-feature vocabulary the CLI implements. ISS-684: this MUST stay
// byte-for-byte identical to the Swift Config.TeamCapabilities.supportedFeatures
// (ClaudeStoryModels/Config.swift) -- both write paths gate on the same set so a
// partially-implemented client fails closed.
export const SUPPORTED_TEAM_FEATURES = new Set([
  "canonical-ids",
  "claims",
  "fractional-rank",
  "global-conflict-blocking",
  "merge-driver",
  "reconcile",
  "remote-ref-reservations",
  "resolver",
  "team-config",
  "tombstones",
]);

// ISS-748: the version MUST come from the build-time constant in bundled builds.
// tsup's `define` replaces the exact dotted expression `process.env.STORYBLOQ_VERSION`
// with the package version literal in every dist bundle (do not rewrite to bracket
// access or destructuring -- esbuild only substitutes the dotted form). The relative
// require below is only correct from the src tree; from dist/ it resolves outside
// the package root (missing on npm installs, the workspace root in this monorepo).
export function currentCliVersion(): string | null {
  const baked = process.env.STORYBLOQ_VERSION;
  if (typeof baked === "string" && baked.trim() !== "") return baked;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * T-522: the first CLI that writes 1.16 ruling records (status, acceptance,
 * proposals). A team-mode ledger admits those records only once its
 * `minCliVersion` fence is at least this, so an older writer cannot produce
 * a record the new readers would quarantine or the old ones would misread.
 */
export const RULING_LIFECYCLE_MIN_CLI_VERSION = "1.16.0";

/**
 * T-486: the first CLI that writes resolution kinds and reads them through
 * the binding projection. A team-mode ledger admits kind writes only behind
 * a fence of at least this. 1.16.0 was never published without them; if that
 * ever stops being true, this must move to the version being published
 * (RELEASE.md, and the old-dist check in test/compat).
 */
export const RESOLUTION_KIND_MIN_CLI_VERSION = "1.16.0";

/** Every capability minimum, in the order `team setup` raises the fence through them. */
export const TEAM_FENCE_MINIMUMS: readonly string[] = [RULING_LIFECYCLE_MIN_CLI_VERSION, RESOLUTION_KIND_MIN_CLI_VERSION];

/**
 * T-522: SemVer-aware "at least" for the rulings fence. `compareVersionStrings`
 * folds a prerelease tag into 0, so `1.16.0-rc` would pass as `1.16.0`; here a
 * prerelease of the minimum's own core is BELOW the minimum (SemVer 11.4), a
 * prerelease of a later core is above it, and anything unparseable is below.
 */
export function meetsVersionMinimum(version: string | undefined, minimum: string): boolean {
  const parse = (v: string): { core: number[]; prerelease: string | null } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    if (!m) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null };
  };
  if (typeof version !== "string") return false;
  const v = parse(version);
  const min = parse(minimum);
  if (v === null || min === null) return false;
  for (let i = 0; i < 3; i++) {
    if (v.core[i]! < min.core[i]!) return false;
    if (v.core[i]! > min.core[i]!) return true;
  }
  // Same core: a prerelease is below a release; a release is at least a prerelease.
  if (v.prerelease === null) return true;
  return min.prerelease !== null && v.prerelease >= min.prerelease;
}

export function compareVersionStrings(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pb = b.split(/[.-]/).map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export function isTeamModeConfig(config: Pick<Config, "team">): boolean {
  return config.team?.enabled === true;
}

export function assertTeamWriteCapabilities(config: Config): void {
  const team = config.team;
  if (!isTeamModeConfig(config)) return;
  // isTeamModeConfig already guarantees `team` is defined here (it returns
  // early otherwise) -- TS can't narrow across that separate function call,
  // so this guard is pure narrowing, never reachable in practice.
  if (!team) return;

  const minCliVersion = team.minCliVersion;
  if (typeof minCliVersion === "string" && minCliVersion.trim() !== "") {
    const current = currentCliVersion();
    if (!current) {
      throw new ProjectLoaderError(
        "version_mismatch",
        `Cannot verify storybloq CLI version against required ${minCliVersion}. Run: npm update -g @storybloq/storybloq`,
      );
    }
    if (compareVersionStrings(current, minCliVersion) < 0) {
      throw new ProjectLoaderError(
        "version_mismatch",
        `This project requires storybloq CLI ${minCliVersion} or later; current CLI is ${current}. Run: npm update -g @storybloq/storybloq`,
      );
    }
  }

  const requiredFeatures = Array.isArray(team.requiredFeatures) ? team.requiredFeatures : [];
  const unsupported = requiredFeatures.filter((feature) => !SUPPORTED_TEAM_FEATURES.has(feature));
  if (unsupported.length > 0) {
    throw new ProjectLoaderError(
      "version_mismatch",
      `This project requires unsupported team feature(s): ${unsupported.join(", ")}. Run: npm update -g @storybloq/storybloq`,
    );
  }
}
